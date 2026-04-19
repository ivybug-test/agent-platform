# CHANGELOG.md

## Project status
Phase 2 done (tool-calling agent + memory tools + UI). Multi-user memory rework (phases A–D of the `streamed-yawning-pancake` plan) also fully landed: subject/author split, pending confirmation flow, room-shared memories, bidirectional user relationships. Dynamic memory Phase A landed 2026-04-19: temporal + strength columns, time-range retrieval, Generative-Agents-style decay scoring, reinforce-over-skip on near-duplicates. Remaining: dynamic memory Phase B (consolidation from recurring events → semantic facts), vector-based memory dedup (D2), MCP integration.

## Current phase
Phase 2 — Agent architecture upgrade (complete); multi-user rework (complete)

## Completed

### Milestone 0: Planning (2026-04-05)
- Defined product direction and phased roadmap
- Reviewed CLAUDE.md for ambiguities and risks
- Confirmed all architecture decisions:
  - TypeScript everywhere
  - agent-runtime as independent Fastify HTTP service
  - OpenAI Node.js SDK with self-built agent orchestration
  - SSE for Phase 1 streaming (WebSocket added in Phase 3/4)
  - Auth.js with credentials provider
  - Drizzle ORM
  - BullMQ for task queue
  - agent-runtime does NOT connect to database; context passed via HTTP body
  - Next.js triggers memory-worker jobs after chat completion
  - MCP support deferred to Phase 2
- Simplified repo structure: removed packages/config, packages/prompts, packages/sdk from MVP
- Added data model details: rooms.system_prompt, room_members.member_type, messages.status, nullable sender_id for system messages
- Defined incremental milestone path (M0→M6)
- Identified and documented development/testing/maintenance risks

## Decisions
- TypeScript everywhere (evaluated Python Agents SDK, chose TS for MVP simplicity)
- Fastify for agent-runtime (independent HTTP service)
- OpenAI Node.js SDK (self-built orchestration to learn agent patterns)
- SSE for streaming in Phase 1
- Auth.js (credentials provider first)
- Drizzle ORM
- BullMQ for async task queue
- Docker Compose for local dev (PostgreSQL + Redis)
- agent-runtime mock mode for UI development
- Streaming message persistence: create with status=streaming, update to completed

### Milestone 1: Monorepo skeleton (2026-04-05)
- Initialized pnpm workspace (pnpm@9.15.4) + Turborepo
- Created root configs: package.json, turbo.json, tsconfig.base.json, .gitignore, .env.example
- Scaffolded apps/web with minimal Next.js App Router setup
- Scaffolded packages/types and packages/db with placeholder exports
- Scaffolded services/agent-runtime with Fastify health endpoint
- Scaffolded services/memory-worker with placeholder
- Created infra/ and docs/ directories
- Verified: `pnpm install` and `pnpm -r build` both succeed

### Milestone 2: Minimal chat chain (2026-04-05)
- agent-runtime: POST /chat endpoint with SSE streaming via OpenAI SDK
- LLM client uses lazy initialization (getClient/getModel) to work with dotenv
- Supports configurable provider via LLM_BASE_URL / LLM_API_KEY / LLM_MODEL env vars
- Mock mode (MOCK_LLM=true) returns fake streaming for UI dev
- apps/web: API route at /api/chat proxies to agent-runtime, streams SSE back
- apps/web: Chat UI with message list, input box, streaming display
- Verified end-to-end: DeepSeek API streaming through Next.js → agent-runtime → browser
- D1 risk resolved: Next.js SSE proxy works correctly via Response body passthrough

### Milestone 3: Database + message persistence (2026-04-05)
- Docker Compose: PostgreSQL 16 + Redis 7 (infra/docker-compose.yml)
- Drizzle schema: users, agents, rooms, room_members, messages, user_memories, room_summaries
- drizzle-kit push + generate migration
- Seed script: demo user + assistant agent + General room
- apps/web: /api/chat now persists user message, creates streaming agent message, updates to completed
- apps/web: /api/messages returns room history, /api/rooms returns room list
- apps/web: page loads history from DB on mount
- Next.js env loading via dotenv (root .env from apps/web)
- Next.js serverExternalPackages for postgres driver
- Verified: messages persist across page refresh

### Milestone 4: Rooms (2026-04-05)
- Refactored page into sidebar + chat panel layout
- Extracted ChatPanel and Sidebar components
- POST /api/rooms creates room and auto-binds default agent
- GET /api/rooms returns all rooms ordered by creation time
- Room switching loads messages per room (ChatPanel re-mounts via key)
- Verified: two rooms with completely isolated message histories

### Milestone 5: Auth (2026-04-05)
- Auth.js (next-auth beta) with credentials provider + JWT strategy
- Register API (/api/register) with bcryptjs password hashing
- Login page + Register page with form validation
- SessionProvider in layout for client-side session access
- Middleware redirects unauthenticated users to /login
- All API routes protected via getRequiredUser() session check
- Rooms associated with users via room_members (membership-based, not owner-only)
- rooms.createdBy field added to schema
- Sidebar shows current user name + logout button
- apps/web/.env.local for Next.js native env loading (AUTH_SECRET, DATABASE_URL)
- Fixed rooms query: two-step query (memberships → rooms) instead of innerJoin

### Milestone 6: Room summaries + User memory (2026-04-10)
- services/memory-worker: BullMQ `memory` queue consumer, dispatching by job name
- apps/web: `lib/queue.ts` `pushMemoryJobs(roomId, userId)` called from `lib/chat/stream.ts` after streaming completes
- Job 1 — room-summary:
  - Triggered every chat turn; skips unless ≥20 new messages since last summary (`SUMMARY_THRESHOLD`)
  - Reads latest 100 messages, resolves real user names, feeds previous summary + transcript to LLM
  - Writes new row into `room_summaries` (append-only; latest row wins at read time)
- Job 2 — user-memory:
  - Deduped per user via `jobId = user-memory-{userId}-{5min-bucket}` (max one extraction per 5 min per user)
  - Skipped if user has <3 messages in room
  - Loads ALL existing memories for the user, groups by category with ids, passes to LLM
  - LLM returns strict JSON `{actions: [create|update|delete]}` via `response_format: json_object`
  - Actions applied in a single DB transaction; validates category/importance enums before write
  - Categories: identity | preference | relationship | event | opinion | context
  - Importance: high | medium | low (drives read-side ordering)
- Schema:
  - `user_memories`: content, category (enum), importance (enum), sourceRoomId, userId, timestamps
  - `room_summaries`: content, messageCount (string), roomId, createdAt (append log)
- Read path (apps/web `lib/chat/context.ts`):
  - `getLatestSummary(roomId)` — most recent summary row
  - `getRoomUsersMemories(roomId)` — memories for ALL user members (max 15/user), ordered by importance then recency, grouped by user name → category
  - `buildSystemPrompt` injects memory section ("What you remember about {name}:") and summary section into the 6-layer prompt
  - Context assembly stays in Next.js per architecture rule; agent-runtime receives fully-built messages array
- Context dedup: bigram-based similarity filter removes near-duplicate agent replies from the window before sending to LLM (CJK-safe)

### Image messages (2026-04-12)
- Users can send images in rooms; images broadcast to other members like text messages, but do not trigger LLM calls
- Storage: Tencent Cloud COS (bucket `agentimage-1411620332`, region `ap-guangzhou`, public-read / private-write)
- Upload path: browser → COS direct, Next.js only signs STS temp credentials
- Compression: browser-side canvas, long edge ≤1600px, JPEG quality 0.8 (via `apps/web/src/lib/upload-image.ts`)
- New route `POST /api/upload/sts` — verifies room membership, issues STS credential scoped to a single key `rooms/{roomId}/{userId}/{yyyymm}/{uuid}.jpg`, 10-minute TTL
- New route `POST /api/messages/image` — validates URL host (`*.myqcloud.com`), persists with `contentType="image"`, `content=publicUrl`, publishes `user-message` Redis event
- `RoomEvent.message` gained optional `contentType` field; ChatPanel renders `<img>` when `contentType === "image"`, otherwise falls back to text
- ChatPanel: new image button uses `<input type="file">`, optimistic local append + seenIds dedup against Socket.IO echo
- Schema unchanged — existing `messages.contentType` varchar(50) was already in place from M3
- Deps added: `qcloud-cos-sts` (server STS signing), `cos-js-sdk-v5` (browser PUT with temp credentials)
- Env: `TENCENT_SECRET_ID`, `TENCENT_SECRET_KEY`, `TENCENT_COS_BUCKET`, `TENCENT_COS_REGION`

## Phase 2 milestones

### A: Memory safety foundation (2026-04-17)
- A1 — schema: `user_memories` gained `source` (enum `extracted | user_explicit`), `deleted_at`, `last_reinforced_at`. Migration `0002_nifty_matthew_murdock.sql`.
- A2 — `getUserMemories` / `getRoomUsersMemories` filter `isNull(deletedAt)` so soft-deletes disappear from the prompt.
- A3 — memory-worker now loads active + tombstoned memories, passes tombstones as "DO NOT RECREATE" in the prompt. Three-layer lock on `source='user_explicit'`: extraction prompt, in-code `lockedIds` guard, SQL `source='extracted'` predicate. Worker DELETE changed from hard to soft (becomes a tombstone) so agent/worker cannot loop create→delete.
- A4 — `/memories` page (list / add / edit / forget) + `GET/POST/PATCH/DELETE /api/memories[/:id]`. All user-UI writes flip `source='user_explicit'`, locking the row against automated overwrite.

### B: Tool-calling infrastructure (2026-04-17)
- B1 — `services/agent-runtime/src/index.ts` runs a tool loop: stream tool_call deltas by `index`, accumulate `id/name/args`, stop on `finish_reason=tool_calls`, POST to `toolCallbackUrl` with `Authorization: Bearer <jwt>`, feed `role:"tool"` results back, continue up to `maxToolRounds` (default 5, hard cap 10). SSE extended with `{tool_call}` + `{tool_result}` events alongside `{content}`. Mock mode gains `mockToolStream` so loop is verifiable without a real key.
- B2 — `apps/web/src/lib/tool-token.ts` signs HS256 JWT via `jose` (`sub=userId`, `roomId`, 10-min TTL). `apps/web/src/app/api/agent/tool/route.ts` verifies and dispatches through `toolRegistry`. Ownership of side effects is derived from the token, never from request args.
- Fix — `packages/logger` read `LOG_DIR` at module-load time, before dotenv ran. Moved the read into `getLogger()` so non-root deployments can override the default `/root/agent-platform/logs`.

### C: On-demand retrieval (2026-04-17)
- C1 — five tools registered in `apps/web/src/lib/tools/memory-tools.ts`:
  - `search_memories({query?, category?, limit})` — ILIKE substring, soft-deletes excluded.
  - `search_messages({query, limit, before?})` — completed messages in the caller's room; ILIKE with `\ % _` escape; sender-name resolution.
  - `remember({content, category, importance})` — writes `source='extracted'` so worker can still correct; bigram-Jaccard near-dup guard (threshold 0.55) short-circuits and returns the similar memory instead of creating.
  - `update_memory({memoryId, content?, category?, importance?})` — stamps `source='user_explicit'` + `lastReinforcedAt=now`.
  - `forget_memory({memoryId, reason?})` — soft delete + `source='user_explicit'`.
- C2 — `buildSystemPrompt` pins only `category='identity' OR importance='high'` memories (cap 8/user) plus the latest summary. Adds a TOOL USAGE section describing when each tool is appropriate and instructing the agent not to call a tool when current context is sufficient. `streamAgentResponse` signs a JWT per request and passes `tools: agentToolDefs`, `toolCallbackUrl`, `toolAuth` through to agent-runtime. Title-generation path kept tool-free.
- End-to-end verified against real DeepSeek: user "请忘掉…我喜欢志龙哥" → agent emitted `search_memories({"query":"志龙哥"})` → `forget_memory({memoryId, reason})` → confirmed in Chinese. DB: row flipped to `deleted_at IS NOT NULL`, `source='user_explicit'`.

## Multi-user memory rework (2026-04-18)

Reshape the memory model from "always 1:1" to "multi-user + single agent". Previously `user_memories.user_id` served both "owner" and "subject" roles; in a group chat any fact the agent tried to remember about a non-speaker ended up attributed to the speaker. Four additive phases, zero destructive migrations.

### Phase 1 — Strict prompt guardrail
- `buildSystemPrompt` appended a STRICT section forbidding remember/update/forget for anyone other than the current speaker, and forbidding search against other members. Zero schema change, deployable immediately.
- `docs/memory-system.md` §12 documents the scope matrix (pinned-vs-tool asymmetry) and the rule.

### Phase 2 — Subject / author split + pending confirmation
- Schema `0004_memory_authorship.sql`: `user_memories` gained `authored_by_user_id` (NULL or = user_id = self; otherwise third-party) and `confirmed_at` (NULL = pending when third-party). Partial index `user_memories_pending_idx` serves the "待确认" listing.
- `apps/web/src/lib/memory-filters.ts` exposes `visibleToSubject()` — the single WHERE expression reused by pinned injection, `search_memories`, `GET /api/memories`, `PATCH /api/memories/:id`, and all the `update_memory` / `forget_memory` paths. Prevents pending rows from appearing anywhere until the subject accepts.
- `apps/web/src/lib/tools/resolvers.ts` · `resolveRoomMemberByName` — case-insensitive exact-match name lookup in room members. Reused by `remember(subjectName)` and (later) `relate`.
- Tools: `remember` gained optional `subjectName`; third-party writes land pending. `update_memory` / `forget_memory` use `visibleToSubject()` so pending rows aren't silently mutated. New `confirm_memory` tool lets the agent accept a pending fact on the subject's behalf mid-conversation.
- API: `GET /api/memories` returns `{ mine, pending }` with author display names resolved. New `POST /api/memories/:id/confirm`. DELETE handles rejection of pending rows.
- UI: `/memories` page gained a tab bar ("我的记忆" / "待确认") with a pending badge and 接受/拒绝 buttons.
- Worker: extraction prompt treats `[PENDING]` rows like `[LOCKED]` (SKIP on duplicate content, forbid UPDATE/DELETE); `pendingIds` joins `lockedIds` as secondary rejection sets in the transaction.
- Prompt: Phase 1's strict rule softened — remember with subjectName is now the right move for clearly useful cross-session facts, but is discouraged for casual mentions.

### Phase 3 — Room-shared memories
- Schema `0005_room_memories.sql`: new `room_memories(id, room_id, content, importance, created_by_user_id, source, deleted_at, ...)` with `room_memories_active_idx` partial index.
- Tools: `search_room_memory`, `save_room_fact`, `forget_room_fact` — all JWT-room-scoped; `forget_room_fact` only touches `source='extracted'` so UI-authored entries are safe from tool-path deletions.
- Injection: `getRoomMemories(roomId)` + `buildSystemPrompt` `roomMemories` field render a new "Room context: ..." layer between room rules and per-user pinned facts.
- API: `GET/POST /api/rooms/:id/memories` + `PATCH/DELETE /api/rooms/:id/memories/:memId`, all gated by room-member check. UI writes → `source='user_explicit'`.
- UI: new `RoomSettings.tsx` modal reached via the Sidebar room ⋯ menu item "房间共享事实". Add / inline-edit / delete.

### Phase 4 — Bidirectional user relationships
- Schema `0006_user_relationships.sql`: `user_relationships(a_user_id, b_user_id, kind, content, confirmed_by_a, confirmed_by_b, ...)`. CHECK `a_user_id < b_user_id` canonicalises pairs; UNIQUE `(a_user_id, b_user_id, kind)` prevents duplicates. Partial indexes on each side.
- Tools: `relate({ otherUserName, kind, content? })` — upserts and fills the speaker's `confirmed_by_*` side only; `search_relationships({ withUserName? })` — returns fully-confirmed edges involving the speaker; `unrelate({ relationshipId })` — soft-delete from either side.
- Injection: `getConfirmedRelationshipsForUser(userId, roomMemberIds)` returns edges where BOTH sides confirmed AND the other side is present in the current room. `buildSystemPrompt` renders "Known relationships involving {speaker}:" layer.
- API: `GET /api/relationships` → `{ confirmed, pending, outgoing }`; `POST /api/relationships` (propose/confirm upsert); `POST /api/relationships/:id/confirm`; `DELETE /api/relationships/:id`.
- UI: `/memories` gained a "关系" tab with three sections (待确认 incoming, 已确认, 已发出 outgoing) and an inline "+ 新增关系" form that picks a mutual friend via `/api/friends`.
- Docs (`docs/memory-system.md`): §2 data model expanded to 3 tables; §12 rewritten to describe the current scope matrix + privacy defaults (自述 public to room, 他述 private to subject, room memory public, relationships bidirectional-consent).

## Dynamic memory, Phase A (2026-04-19)

Give memory a time dimension and let it evolve. Inspired by Park et al.'s
Generative Agents (recency × importance × relevance) and MemoryBank
(Ebbinghaus-style decay).

- Schema `0007_memory_temporal.sql`: `user_memories` gained `event_at timestamptz` and `strength real NOT NULL DEFAULT 1.0`. Partial index `user_memories_event_at_idx (user_id, event_at DESC) WHERE deleted_at IS NULL AND event_at IS NOT NULL` to serve time-range retrieval.
- Agent prompt (`buildSystemPrompt`): new Layer 1b injects `Current time: YYYY-MM-DD HH:mm Weekday (Asia/Shanghai)` so the LLM resolves "今天" / "昨天" / "刚才" against a concrete anchor before any memory write.
- Extraction worker (`services/memory-worker/src/jobs/user-memory.ts`):
  - Messages now fed to the LLM with per-line `[YYYY-MM-DD HH:mm]` timestamps plus a "Current time" banner. Prompt forbids storing relative phrases and requires `eventAt` on CREATE actions for time-bound facts.
  - Transient facts ("我现在饿了") must be SKIPPED — recurring behaviours surface via reinforcement, not seed rows.
  - **Near-duplicate ≥0.55 Jaccard → REINFORCE, not skip.** Existing row's `strength += 1` and `last_reinforced_at = now()`. Locked / pending rows fall through to the old skip path. This is the core dynamic-memory signal: repeated mentions grow strength; never-mentioned rows decay on read.
- `remember` tool (`memory-tools.ts`): accepts optional `eventAt` ISO string; on near-dup hit, reinforces the existing memory instead of returning `skipped`. Locked / pending rows still short-circuit to skip.
- `search_memories` tool: new optional `from` / `to` ISO params. When a time filter is present, result set is restricted to rows with non-NULL `event_at` and ordered by `event_at DESC` (chronological retrieval). `event_at` is included in the result rows so the agent can read it back.
- `search_messages` tool: symmetric `after` param added (mirrors existing `before`); chronological ASC ordering when `after` is set.
- Read-path ranking (`context.ts`): `MEMORY_SCORE_SQL = strength × importance_weight × exp(-age_days / 30)` where age is measured against `COALESCE(last_reinforced_at, updated_at)`. Used by both `getUserMemories` and `getRoomUsersMemories` pinned injection. 30-day half-life chosen as a tunable MVP constant.
- `infra/update.sh`: adds 0007 to the idempotent raw-SQL migration list.
- Docs: `docs/memory-system.md` updated — §2 data model +3 columns, §4 writes note reinforcement, new §15 dynamic-memory section covering score formula + time-range tool usage.

Note: `memory-worker` log key renamed `dupSkipped → reinforced`. Grafana/log consumers filtering on the old key need to be updated.

## Post-Phase-A follow-ups (2026-04-19)

Shipped the same day Phase A landed, once live usage surfaced gaps.

### Temporal awareness in the recent-message window
- `buildLLMMessages`: every user message line is now prefixed with `[YYYY-MM-DD HH:mm]` in Asia/Shanghai, so the agent sees time flow across the 50-message window rather than just the single "Current time" anchor. Cost: ~18 tokens/line, negligible at 8k ctx.
- If the most recent message is >6h old, a one-line gap note is appended to the system prompt ("about 3 days have passed since the last message in this room") so the agent can open with "好久不见" naturally rather than acting like no time passed.
- Important fix: timestamps are NOT prefixed to assistant messages. An earlier iteration prefixed both, and the LLM mimicked the pattern — every reply started with `[2026-04-19 13:56] ...`. System prompt rule #2 additionally spells out that the bracketed stamp is metadata to be read, not echoed.

### Retrieval reinforces recency (Park et al. other half)
- `search_memories`: after the select, fires a non-blocking `UPDATE user_memories SET last_reinforced_at = now()` on the returned row ids. `strength` is intentionally untouched — that tracks how often a fact was claimed; retrieval is a different signal that only moves the decay anchor.
- Closes a real gap: facts heavily USED by the agent (e.g. "住在深圳" queried every restaurant-recommendation turn) used to decay out of pinned if the user never re-stated them. Now stay fresh as long as they're being looked up.
- Applies to both `source='extracted'` and `user_explicit` rows — no content/category/deletion mutation, so user-locked facts are safe.

### Chat UI
- ChatPanel: each message now shows `HH:mm` next to the sender name; a day-divider pill appears whenever the day boundary crosses (`今天` / `昨天` / `MM月DD日 周X`, adds year if >365d old). Asia/Shanghai formatting.
- Sidebar: rooms now sort by most recent activity. `GET /api/rooms` returns `lastActivityAt` via a correlated subquery `MAX(messages.created_at WHERE status='completed')`, falling back to `rooms.created_at`. A new `UserEvent: room-activity {roomId, at}` is published by the user-message save path and the agent-message completion path (`publishRoomActivity` helper) to every room member; the client updates the matching row and re-sorts.
- FLIP animation: when `rooms` reorders, `useLayoutEffect` snapshots each row's `offsetTop`, measures again after layout, applies an inverting translateY for moved rows, then transitions back to zero with 260ms cubic-bezier. No animation library — plain DOM.

### Cross-browser compat: "white sidebar" on older Huawei / HarmonyOS / Quark
Root cause: DaisyUI v5 declares every theme color as `oklch()`. Browsers older than Chromium 111 reject the whole `--color-base-*` declaration as invalid, leaving the variable unset; `bg-base-200` / `bg-base-300` paint white. Three-part fix:
- `globals.css`: `@supports not (color: oklch(0% 0 0)) { [data-theme="dark"], :root { --color-base-100: #1d232a; ... } }` — only triggers on browsers without oklch support; modern browsers keep DaisyUI's oklch intact.
- `layout.tsx`: moved `data-theme="dark"` onto `<html>` so the attribute selector resolves at the root and every descendant inherits. Nested copies in sub-components left in place as belt-and-suspenders.
- Added `colorScheme: "dark"` + `themeColor: "#111111"` to the Next `Viewport` export so mobile scrollbars / form controls / address bar render in dark mode too.

### Legacy data cleanup CLIs
- `services/memory-worker` · `pnpm backfill-event-at [--dry-run]` — replays `source='extracted'` rows through the LLM to populate `event_at` from their content. Anchors relative phrases (`今天` / `昨天` / `刚才`) against the row's own `created_at` (≈ when the user message was sent). Source-locked SQL predicate guards user_explicit rows. Idempotent.
- `services/memory-worker` · `pnpm strip-numbered-prefix [--dry-run]` — pure regex cleanup of `^\s*\d+\.\s+` prefixes that an earlier extractor accidentally stored as memory content. No LLM.

### update.sh robustness
- Replaced bash-only `source` with POSIX `.` for dash compatibility.
- Self-modifying-script guard: pulls first, then `exec "$0" "$@"` so the rest of the run executes against the freshly-pulled file (prevents line-offset corruption when `git pull` rewrites `update.sh` itself mid-run).

## Not started
- Phase 2 D1 — pg_trgm GIN index on `messages.content` so `search_messages` stays fast past a few thousand rows.
- Phase 2 D2 — systematic memory dedup (pgvector + cosine, or periodic cron merge). C1's `remember` has only the bigram quickdup.
- Dynamic memory Phase B — periodic consolidation: cluster recurring `category='event'` memories with similar content + different `event_at` → LLM emits a higher-level semantic fact ("经常不吃午饭"), original events kept as evidence, stale ones decay out.
- Phase 2 MCP support — third-party tool integration via Model Context Protocol.
- Phase 2 prompt versioning (`packages/prompts` extraction).

## Risks / notes
- D1 historical: Next.js SSE proxy — resolved in M2.
- D3 historical: mock mode for UI dev — done.
- Phase 2 risk — mock mode only emits one synthetic tool_call path (always the first tool in the defs list). Real-LLM behavior (tool choice, repeated rounds, argument shape variance) must be exercised with a live key; do not rely on mock-mode coverage for C1/C2.
- Phase 2 risk — `remember`'s similarity threshold (0.55 bigram Jaccard) blocks obvious rewrites but not paraphrases; semantic dedup waits on D2.
- Phase 2 risk — memory-worker still uses synchronous OpenAI calls with no mock path. Background jobs will fail loudly if `LLM_API_KEY` is empty.

## Next step
Phase A is now feature-complete including retrieval-side reinforcement. D2 (semantic memory dedup via pgvector + embedding) is the next major piece — without it the Phase A reinforce signal scatters across paraphrased duplicates ("喜欢甜食" vs "爱吃蛋糕") instead of concentrating on one row. D2 is also a prerequisite for Phase B: consolidation needs a clean base to cluster events. Phase B itself (recurring episodic → semantic facts) still waits on ≥2 weeks of real reinforcement data before its clustering thresholds can be calibrated. After D2/Phase B, evaluate MCP and authorization-model (e.g. subject-muting of specific authors) needs.

## Update rule
After each meaningful implementation step, append:
- what was completed
- any design decisions made
- any failed approach worth remembering
- the next recommended step
