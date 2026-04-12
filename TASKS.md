# TASKS.md

## Phase 1 — Text MVP

Development follows an incremental path. Each milestone is independently verifiable.

---

### Milestone 0: Planning docs ✅
- [x] Define product direction and architecture
- [x] Confirm all tech decisions (Fastify, OpenAI Node SDK, Drizzle, BullMQ, Auth.js)
- [x] Update CLAUDE.md with confirmed decisions
- [x] Update TASKS.md with milestones
- [x] Update CHANGELOG.md

### Milestone 1: Monorepo skeleton ✅
Dependencies: none

- [x] Initialize pnpm workspace
- [x] Add Turborepo config
- [x] Create root package.json with dev/build/lint scripts
- [x] Create `.gitignore`
- [x] Create `.env.example`
- [x] Scaffold directories with package.json + tsconfig.json:
  - [x] apps/web (Next.js)
  - [x] packages/types
  - [x] packages/db
  - [x] services/agent-runtime (Fastify)
  - [x] services/memory-worker
  - [x] infra
  - [x] docs

**Verified**: `pnpm install` succeeds, `pnpm -r build` runs without errors.

### Milestone 2: Minimal chat chain (no DB, no auth) ✅
Dependencies: Milestone 1

- [x] agent-runtime: Fastify server with POST /chat endpoint
  - [x] Accept messages array in request body
  - [x] Call OpenAI API with streaming
  - [x] Return SSE stream
  - [x] Support mock mode (env var: MOCK_LLM=true)
- [x] apps/web: Simple chat page
  - [x] Message list component
  - [x] Message input component
  - [x] Call Next.js API route on send
  - [x] Display streaming response
- [x] apps/web: API route that proxies to agent-runtime SSE
- [x] Hardcoded user, no persistence (refresh = gone)

**Verified**: Both services running, DeepSeek streaming reply works in browser.

### Milestone 3: Database + message persistence ✅
Dependencies: Milestone 2

- [x] infra: Docker Compose with PostgreSQL + Redis
- [x] packages/db: Drizzle schema
  - [x] users table
  - [x] agents table
  - [x] rooms table (with system_prompt)
  - [x] room_members table (with member_type)
  - [x] messages table (with status field)
  - [x] user_memories table
  - [x] room_summaries table
- [x] packages/db: Migration setup (drizzle-kit)
- [x] packages/db: Seed script (create default user + agent + room)
- [x] apps/web: API route persists user message before calling agent-runtime
- [x] apps/web: API route persists agent message after streaming completes
- [x] apps/web: Load message history on page load

**Verified**: Messages persist across page refresh.

### Milestone 4: Rooms ✅
Dependencies: Milestone 3

- [x] Room list page
- [x] Create room UI
- [x] Room detail page with chat
- [x] Each room has independent message history
- [x] One agent bound per room
- [x] Room navigation

**Verified**: Two rooms created, messages isolated between rooms.

### Milestone 5: Auth ✅
Dependencies: Milestone 3

- [x] Auth.js setup with credentials provider
- [x] Login page
- [x] Register page
- [x] Protect API routes with session check
- [x] Associate rooms with users
- [x] Show only user's own rooms (via room_members membership)

**Verified**: Two users (binqiu, bob) log in separately, each sees only their own rooms.

### Milestone 6: Room summaries + User memory ✅
Dependencies: Milestone 3

- [x] services/memory-worker: BullMQ consumer setup
- [x] apps/web: Push job to BullMQ after chat completion (pushMemoryJobs in stream.ts)
- [x] memory-worker: Room summary generation job (threshold = 20 new messages)
- [x] memory-worker: User memory extraction job (CRUD actions via JSON mode)
- [x] Persist summaries and memories to database
- [x] apps/web: Include summary + memory in context passed to agent-runtime
- [x] agent-runtime: Use provided context in prompt assembly (system prompt built in web, passed via messages array)

**Verified**: Agent recalls prior user facts across sessions; summaries regenerate past threshold.

---

## Milestone dependency graph
```
M0 → M1 → M2 → M3 → M4
                  ↓      ↘
                  M5      M6
```
M4, M5, M6 all depend on M3 but are independent of each other.

---

## Immediate next task
Phase 1 complete. Next: begin Phase 2 (agent architecture upgrade — tool calling, MCP, memory retrieval tools, prompt versioning).
