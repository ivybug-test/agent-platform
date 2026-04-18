# CHANGELOG.md

## Project status
Phase 2 done (tool-calling agent + memory tools + UI). Multi-user memory rework (phases A–D of the `streamed-yawning-pancake` plan) also fully landed: subject/author split, pending confirmation flow, room-shared memories, bidirectional user relationships. Remaining: vector-based memory dedup (D2), MCP integration.

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

## Not started
- Phase 2 D1 — pg_trgm GIN index on `messages.content` so `search_messages` stays fast past a few thousand rows.
- Phase 2 D2 — systematic memory dedup (pgvector + cosine, or periodic cron merge). C1's `remember` has only the bigram quickdup.
- Phase 2 MCP support — third-party tool integration via Model Context Protocol.
- Phase 2 prompt versioning (`packages/prompts` extraction).

## Risks / notes
- D1 historical: Next.js SSE proxy — resolved in M2.
- D3 historical: mock mode for UI dev — done.
- Phase 2 risk — mock mode only emits one synthetic tool_call path (always the first tool in the defs list). Real-LLM behavior (tool choice, repeated rounds, argument shape variance) must be exercised with a live key; do not rely on mock-mode coverage for C1/C2.
- Phase 2 risk — `remember`'s similarity threshold (0.55 bigram Jaccard) blocks obvious rewrites but not paraphrases; semantic dedup waits on D2.
- Phase 2 risk — memory-worker still uses synchronous OpenAI calls with no mock path. Background jobs will fail loudly if `LLM_API_KEY` is empty.

## Next step
D2 (semantic memory dedup via pgvector + embedding) is the biggest remaining item — bigram dedup plus the new auto-merge tier cover lexically-similar cases but still miss paraphrases. After that, evaluate MCP integration timing and whether multi-user chat usage warrants a further authorization model (e.g. subject-muting of specific authors).

## Update rule
After each meaningful implementation step, append:
- what was completed
- any design decisions made
- any failed approach worth remembering
- the next recommended step
