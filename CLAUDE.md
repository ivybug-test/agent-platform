# CLAUDE.md

## Project
Build a small agent chat platform for web.

The product should support:
- user ↔ agent chat
- group chat with users and agents
- persistent message history
- long-term memory
- later voice chat
- later video / RTC rooms

## Current infrastructure
- one 4G / 60G cloud server
- one public VPS
- domain already purchased

## Product strategy
Build the product in phases.

### Phase 1: Text MVP
Must include:
- auth
- rooms
- room membership
- text chat
- one agent per room
- streaming responses
- persistent messages
- room summaries
- basic user memory

### Phase 2: Agent architecture upgrade
Add:
- agent runtime separation
- tool calling
- memory retrieval tools
- better prompt/version management

### Phase 3: Voice
Add:
- realtime voice input/output
- interruption support
- voice session persistence

### Phase 4: RTC / video
Add:
- multi-user voice/video rooms
- agent as room participant
- room events and presence

## Non-goals for MVP
Do NOT implement these in Phase 1:
- video chat
- RTC infra
- autonomous multi-agent debates
- billing/payments
- complex moderation dashboards
- large knowledge-base ingestion
- mobile app
- plugin marketplace

## Tech stack
Use:
- TypeScript
- pnpm workspace
- Turborepo
- Next.js for frontend
- Node.js services
- PostgreSQL
- Redis

## Repo structure
Use a monorepo.

Top-level structure should be:

- apps/web
- packages/types
- packages/config
- packages/db
- packages/prompts
- packages/sdk
- services/agent-runtime
- services/memory-worker
- services/realtime-gateway (may be scaffolded but not fully implemented in Phase 1)
- infra
- docs

## Architecture rules

### Frontend
- The main frontend lives in `apps/web`
- Use Next.js App Router
- Build a simple but clean chat UI
- Keep components modular
- Separate room UI, chat UI, and voice UI components

### Agent runtime
- All agent orchestration logic must live in `services/agent-runtime`
- Do not embed complex agent logic directly inside route handlers
- The runtime should be responsible for:
  - context building
  - prompt assembly
  - tool execution
  - streaming result handling
  - memory read/write decisions

### Memory
- Memory extraction must be asynchronous where possible
- `services/memory-worker` should handle:
  - room summarization
  - user memory extraction
  - embedding/index tasks later
- Do not block the main chat request on slow memory extraction work

### Prompts
- Prompts must live under `packages/prompts`
- Do not hardcode long prompts inside controllers or UI code
- Prompt files should be versionable and organized by purpose:
  - system prompts
  - memory prompts
  - tool prompts

### Data
- PostgreSQL is the source of truth for app data
- Redis is for cache, queue, online presence, and transient stream state
- Do not treat model conversation state as the only source of truth
- User data and persistent memory must remain app-owned

## Initial database entities
The first schema should include at least:

- users
- agents
- rooms
- room_members
- messages
- user_memories
- room_summaries

Later additions may include:
- message_parts
- tool_call_logs
- voice_sessions
- rtc_rooms
- attachments
- agent_profiles

## Messaging model
A room contains users and optionally agents.

Messages should store:
- room id
- sender type (`user`, `agent`, or `system`)
- sender id
- content
- content type
- status
- timestamps

Streaming responses should be persisted safely.
If partial storage is added, use a separate `message_parts` or equivalent model.

## Context strategy
The model context should be assembled in layers:

1. system prompt
2. room rules
3. relevant user memory
4. latest room summary
5. recent messages
6. current user input

Never send the entire room history blindly.

## Development preferences
- Prefer small, reviewable changes
- Prefer clear file and module boundaries
- Prefer explicit typing
- Add comments only where they help
- Avoid overengineering the MVP
- Build the text-chat path first
- Keep future voice/video expansion in mind, but do not prematurely build it

## Coding preferences
- Use TypeScript everywhere unless there is a strong reason not to
- Keep shared types in `packages/types`
- Keep environment parsing in `packages/config`
- Keep database access in `packages/db`
- Prefer service/repository separation for backend logic
- Use clear names, not clever names

## Operational preferences
- Add `.env.example`
- Keep production deployment in `infra`
- Prefer Docker-friendly structure
- Make local development straightforward

## How to work
When asked to implement something:
1. inspect the current repo state
2. read this file
3. check `CHANGELOG.md`
4. check `TASKS.md`
5. implement the smallest useful next step
6. update `CHANGELOG.md`

## Important constraint
Do not jump ahead into voice/video/RTC until text chat, persistence, and memory basics are stable.
