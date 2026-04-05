# CHANGELOG.md

## Project status
Project not yet initialized.

## Current phase
Phase 1 — Text MVP

## Completed
- Defined product direction
- Defined high-level architecture
- Defined phased roadmap
- Defined monorepo structure
- Decided to prioritize text chat before voice/video
- Decided to separate agent runtime and memory worker
- Decided to keep prompts in `packages/prompts`
- Decided to keep persistent app-owned memory in database

## Decisions
- Use TypeScript
- Use Next.js for web app
- Use PostgreSQL as primary database
- Use Redis for queue/cache/presence
- Use monorepo structure
- Use `services/agent-runtime` for agent orchestration
- Use `services/memory-worker` for async summarization and memory extraction
- MVP focuses on text chat only

## Not started
- monorepo initialization
- frontend scaffolding
- shared package scaffolding
- database schema
- room APIs
- chat streaming path
- memory worker jobs

## Risks / notes
- Do not overbuild RTC/video early
- Do not put agent orchestration directly into UI routes
- Do not use raw chat history as the only memory strategy
- Need to keep scope tight for MVP

## Next step
Initialize the monorepo and scaffold the first directories:
- apps/web
- packages/types
- packages/config
- packages/db
- packages/prompts
- packages/sdk
- services/agent-runtime
- services/memory-worker
- infra

## Update rule
After each meaningful implementation step, append:
- what was completed
- any design decisions made
- any failed approach worth remembering
- the next recommended step
