# CHANGELOG.md

## Project status
Milestone 5 complete. Ready to start Milestone 6.

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

## Not started
- Milestone 6: Memory

## Risks / notes
- D1: Next.js SSE proxy may be tricky — validate in Milestone 2 early
- D3: Need mock mode to avoid costly OpenAI calls during UI dev
- Backup plan if SSE proxy fails: frontend calls agent-runtime directly

## Next step
Milestone 6: Room summaries + User memory.

## Update rule
After each meaningful implementation step, append:
- what was completed
- any design decisions made
- any failed approach worth remembering
- the next recommended step
