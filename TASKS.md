# TASKS.md

## Phase 1 — Text MVP

### Task group 1: Repository bootstrap
- [ ] Initialize pnpm workspace
- [ ] Add Turborepo config
- [ ] Create root package.json
- [ ] Create `.env.example`
- [ ] Scaffold top-level directories:
  - [ ] apps/web
  - [ ] packages/types
  - [ ] packages/config
  - [ ] packages/db
  - [ ] packages/prompts
  - [ ] packages/sdk
  - [ ] services/agent-runtime
  - [ ] services/memory-worker
  - [ ] services/realtime-gateway
  - [ ] infra
  - [ ] docs

### Task group 2: Web app scaffold
- [ ] Initialize Next.js app in `apps/web`
- [ ] Add base layout
- [ ] Add auth pages
- [ ] Add rooms list page
- [ ] Add room detail page
- [ ] Add basic chat UI components:
  - [ ] message list
  - [ ] message item
  - [ ] message input
  - [ ] typing / streaming state

### Task group 3: Shared packages
- [ ] Add `packages/types`
- [ ] Add `packages/config`
- [ ] Add `packages/db`
- [ ] Add `packages/prompts`
- [ ] Add `packages/sdk`

### Task group 4: Database schema
- [ ] Choose ORM / DB access strategy
- [ ] Add initial schema for:
  - [ ] users
  - [ ] agents
  - [ ] rooms
  - [ ] room_members
  - [ ] messages
  - [ ] user_memories
  - [ ] room_summaries
- [ ] Add migration setup
- [ ] Add seed strategy

### Task group 5: Backend chat path
- [ ] Add API route / service for sending a message
- [ ] Persist user messages
- [ ] Trigger agent runtime
- [ ] Stream agent response back to client
- [ ] Persist final agent response
- [ ] Handle failure and retry state

### Task group 6: Agent runtime
- [ ] Scaffold `services/agent-runtime`
- [ ] Add context builder
- [ ] Add prompt loader
- [ ] Add simple provider wrapper
- [ ] Add one default chat agent
- [ ] Add token/context budget strategy

### Task group 7: Memory worker
- [ ] Scaffold `services/memory-worker`
- [ ] Add room summary job
- [ ] Add user memory extraction job
- [ ] Add queue interface
- [ ] Persist summary and memory outputs

### Task group 8: MVP quality bar
- [ ] User can create a room
- [ ] User can send a text message
- [ ] Agent can reply with streaming text
- [ ] Refreshing the page keeps message history
- [ ] Room summary can be generated
- [ ] Basic user memory can be stored and retrieved

---

## Immediate next task
Initialize the repository and scaffold the monorepo structure.

## Execution instruction for Claude
When starting work:
1. Read `CLAUDE.md`
2. Read `CHANGELOG.md`
3. Inspect current repo state
4. Complete the smallest useful next step
5. Update `CHANGELOG.md`
