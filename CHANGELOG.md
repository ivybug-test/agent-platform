# CHANGELOG.md

## Project status
Phase 1 (Text MVP) complete — all milestones M0–M6 done. Ready to begin Phase 2.

## Current phase
Phase 1 — Text MVP

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

## Not started
- Phase 2: Agent architecture upgrade (tool calling, MCP, memory retrieval tools, prompt versioning)

## Risks / notes
- D1: Next.js SSE proxy may be tricky — validate in Milestone 2 early
- D3: Need mock mode to avoid costly OpenAI calls during UI dev
- Backup plan if SSE proxy fails: frontend calls agent-runtime directly

## Next step
Begin Phase 2: agent architecture upgrade — tool calling, MCP support, memory retrieval as a tool instead of always-on injection, prompt versioning.

## Update rule
After each meaningful implementation step, append:
- what was completed
- any design decisions made
- any failed approach worth remembering
- the next recommended step
