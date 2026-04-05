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
- tool calling
- MCP support (third-party tool integration via Model Context Protocol)
- memory retrieval tools
- better prompt/version management
- evaluate migration to Python Agents SDK if orchestration complexity warrants it

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
- TypeScript (everywhere)
- pnpm workspace
- Turborepo
- Next.js (App Router) for frontend
- Fastify for agent-runtime HTTP service
- OpenAI Node.js SDK for LLM calls (self-built agent orchestration)
- Drizzle ORM for database access
- Auth.js (credentials provider, expand to OAuth later)
- BullMQ for task queue (Redis-based)
- PostgreSQL
- Redis

## Repo structure
Use a monorepo.

Top-level structure:

- apps/web — Next.js frontend (TypeScript)
- packages/types — shared TypeScript types
- packages/db — Drizzle schema + migrations
- services/agent-runtime — Fastify + OpenAI Node SDK (TypeScript)
- services/memory-worker — BullMQ worker (TypeScript)
- services/realtime-gateway — (Phase 3+, not implemented in Phase 1)
- infra — Docker Compose, Dockerfiles
- docs — documentation

Packages deferred until needed:
- packages/config — env parsing (inline for now)
- packages/prompts — prompt files (inside agent-runtime for now)
- packages/sdk — API client (define when needed)

## Architecture rules

### Communication path (Phase 1)
```
Frontend → Next.js API route → agent-runtime (Fastify/SSE) → streaming response
```
- realtime-gateway is NOT involved in Phase 1
- Phase 3/4 will add WebSocket via realtime-gateway (coexists with SSE)

### Frontend
- The main frontend lives in `apps/web`
- Use Next.js App Router
- Build a simple but clean chat UI
- Keep components modular
- Separate room UI, chat UI, and voice UI components

### Agent runtime
- `services/agent-runtime` is an **independent Fastify HTTP service**
- Next.js API routes call it over HTTP
- It does **NOT** connect to the database directly
- Context (messages, memory, summaries) is passed in via the HTTP request body
- The runtime is responsible for:
  - prompt assembly from provided context
  - LLM API calls (OpenAI)
  - streaming result handling (SSE)
  - tool execution (Phase 2)
- Must support a **mock mode** (env var controlled) that returns fake streaming responses for UI development

### Memory
- Memory extraction must be asynchronous
- `services/memory-worker` uses BullMQ to consume tasks from Redis
- **Next.js is responsible for triggering memory tasks**: after receiving a complete agent response, it persists the message and pushes a job to BullMQ
- `services/memory-worker` handles:
  - room summarization
  - user memory extraction
  - embedding/index tasks later
- Do not block the main chat request on slow memory extraction work

### Prompts
- In Phase 1, prompts live inside `services/agent-runtime`
- Do not hardcode long prompts inside route handlers or UI code
- Prompt files should be organized by purpose (system, memory, tool)
- In Phase 2, consider extracting to `packages/prompts` for versioning

### Data
- PostgreSQL is the source of truth for app data
- Redis is for cache, queue, online presence, and transient stream state
- Do not treat model conversation state as the only source of truth
- User data and persistent memory must remain app-owned

## Initial database entities
The first schema should include at least:

- users
- agents
- rooms (include `system_prompt` text field for room-specific rules)
- room_members (include `member_type` field: 'user' | 'agent' — schema supports multi-agent, Phase 1 logic handles single agent only)
- messages
- user_memories
- room_summaries

### Messaging model
A room contains users and optionally agents.

Messages should store:
- room id
- sender type (`user`, `agent`, or `system`)
- sender id (nullable — null for system messages)
- content
- content type
- status (`sending`, `streaming`, `completed`, `failed`)
- timestamps

**Streaming persistence rule**: When an agent starts responding, create a message record with status=`streaming`. Update to status=`completed` with full content when done. This prevents message loss on connection interruption.

Later additions may include:
- message_parts
- tool_call_logs
- voice_sessions
- rtc_rooms
- attachments
- agent_profiles

## Context strategy
The model context should be assembled by Next.js and passed to agent-runtime. Layers:

1. system prompt
2. room system_prompt (room-specific rules)
3. relevant user memory
4. latest room summary
5. recent messages
6. current user input

Never send the entire room history blindly.

## Local development
- Docker Compose provides PostgreSQL + Redis (`infra/docker-compose.yml`)
- Turborepo manages all TypeScript services (dev/build/lint)
- `pnpm dev` starts all services concurrently
- Each service can also be started independently

## Development preferences
- Prefer small, reviewable changes
- Prefer clear file and module boundaries
- Prefer explicit typing
- Add comments only where they help
- Avoid overengineering the MVP
- Build the text-chat path first
- Keep future voice/video expansion in mind, but do not prematurely build it
- **Develop incrementally**: smallest runnable path first, verify each step

## Coding preferences
- Use TypeScript everywhere
- Keep shared types in `packages/types`
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
