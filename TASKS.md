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

## Phase 1 milestone dependency graph
```
M0 → M1 → M2 → M3 → M4
                  ↓      ↘
                  M5      M6
```
M4, M5, M6 all depend on M3 but are independent of each other.

---

## Phase 2 — Agent architecture upgrade

Goal: move from always-on memory injection to tool-based, on-demand retrieval. Give the user (and the agent) a way to correct and forget facts.

### Checkpoint A — Memory safety foundation ✅
- [x] A1: extend `user_memories` schema (source / deleted_at / last_reinforced_at) + migration
- [x] A2: filter soft-deleted memories in read path (`context.ts`)
- [x] A3: memory-worker respects tombstones + `source='user_explicit'` lock (prompt + code + SQL)
- [x] A4: "我的记忆" management API + `/memories` page; user edits flip source to `user_explicit`

### Checkpoint B — Tool-calling infrastructure ✅
- [x] B1: agent-runtime tool-calling loop (SSE tool_call/result events, JWT opaque passthrough, max rounds)
- [x] B2: `POST /api/agent/tool` JWT-verified dispatcher + `toolRegistry`
- [x] Side fix: `packages/logger` now reads `LOG_DIR` lazily so non-root deployments work

### Checkpoint C — On-demand retrieval ✅
- [x] C1: five tools — `search_memories`, `search_messages`, `remember` (bigram dedup), `update_memory`, `forget_memory`
- [x] C2: `buildSystemPrompt` pins only identity + high-importance; `stream.ts` signs JWT and ships tools to agent-runtime
- [x] E2E verified with real DeepSeek: forget flow works across tool rounds and languages

### Checkpoint D — Retrieval hardening
- [ ] D1: `pg_trgm` GIN index on `messages.content` for `search_messages`; consider tsvector with zhparser for Chinese later
- [ ] D2: systematic memory dedup — embeddings + pgvector OR periodic cron that pairs near-duplicate rows and merges them via LLM

### Checkpoint E — Stabilization
- [x] CHANGELOG + TASKS brought up to date
- [ ] Live smoke test of `remember` (uncovered in current run — only forget was exercised end-to-end)
- [ ] Consider evaluation harness so Phase 2 regressions surface (manual flow for now)

### Deferred within Phase 2
- [ ] MCP support — gate on real third-party tool need
- [ ] Prompt versioning (`packages/prompts`) — gate on a first prompt regression or A/B need
- [ ] Memory-worker mock/offline mode — gate on CI or shared-machine dev needs

---

## Dynamic memory

Goal: give memory a time dimension and let it evolve — episodic facts get absolute timestamps, repeated mentions reinforce, unused memories decay, and recurring events consolidate into higher-level semantic facts.

### Phase A — Temporal + reinforcement + decay ✅ (2026-04-19)
- [x] Schema `0007_memory_temporal.sql`: `user_memories.event_at timestamptz`, `user_memories.strength real DEFAULT 1.0`, partial index `user_memories_event_at_idx` for time-range retrieval
- [x] Agent prompt `Layer 1b`: `Current time: YYYY-MM-DD HH:mm Weekday (Asia/Shanghai)` so relative phrases resolve against a concrete anchor
- [x] Extraction worker: per-message `[timestamp]` prefix + current-time banner; require `eventAt` on time-bound CREATEs; forbid relative phrases in content; skip transient states ("饿了" / "累了")
- [x] **Near-dup → REINFORCE, not skip**: worker and `remember` tool bump `strength += 1` + `last_reinforced_at = now()` on Jaccard ≥0.55 hits (locked/pending rows still short-circuit to skip)
- [x] `search_memories`: `from` / `to` ISO params → time-window retrieval ordered by `event_at DESC`; returns `event_at` in result rows
- [x] `search_messages`: symmetric `after` param (mirrors existing `before`)
- [x] Read-path ranking: `MEMORY_SCORE_SQL = strength × importance_weight × exp(-age_days/30)` applied to `getUserMemories` and `getRoomUsersMemories`
- [x] `infra/update.sh` picks up 0007 idempotently
- [x] Docs: `CHANGELOG.md` section + `docs/memory-system.md` §15

### Phase B — Consolidation (recurring episodic → semantic)
- [ ] Periodic worker job: cluster same-user `category='event'` rows with similar content and spread `event_at` (≥3 occurrences over a tunable window)
- [ ] LLM judges whether a cluster represents a pattern; if yes, emit a semantic fact ("经常不吃午饭") with `importance='medium'`, preserve originals as evidence
- [ ] Gate: wait until Phase A has produced ≥2 weeks of real reinforcement data so the clustering threshold can be calibrated, not guessed

### Phase C — Decay threshold + retrieval boost
- [ ] Hard score threshold on pinned injection (currently only ordered, not cut)
- [ ] Reading a memory via `search_memories` bumps `last_reinforced_at` (Park et al. original semantics — retrieval boosts recency)
- [ ] Tune `DECAY_HALFLIFE_DAYS` + importance weights on observed data

---

## Immediate next task
Let dynamic memory Phase A bake for ~2 weeks, then tackle D2 (pgvector semantic dedup) or dynamic memory Phase B (consolidation) — whichever surfaces a clearer need from real traffic. D1 (pg_trgm index for `search_messages`) is pre-landed in migration 0003.
