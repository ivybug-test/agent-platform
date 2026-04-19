-- Phase A of dynamic memory: temporal + reinforcement columns on user_memories.
--
--   event_at  — when the fact happened (resolved from relative time phrases
--               like "今天" / "yesterday" at extraction/write time). NULL for
--               timeless facts (identity, preferences, etc).
--   strength  — reinforcement counter. Every time a near-duplicate is seen in
--               extraction or via the `remember` tool, we bump this instead of
--               inserting a new row. Read paths compose it with importance
--               and a decay factor over `last_reinforced_at` to rank memories.
--
-- Idempotent — safe to re-run against a DB that already has the columns (e.g.
-- where pnpm db:push already emitted them from schema.ts).
ALTER TABLE user_memories
  ADD COLUMN IF NOT EXISTS event_at timestamptz;
--> statement-breakpoint
ALTER TABLE user_memories
  ADD COLUMN IF NOT EXISTS strength real NOT NULL DEFAULT 1.0;
--> statement-breakpoint
-- Index to support event_at range queries (future time-based retrieval tool).
-- Partial on active rows only to keep it small.
CREATE INDEX IF NOT EXISTS user_memories_event_at_idx
  ON user_memories (user_id, event_at DESC)
  WHERE deleted_at IS NULL AND event_at IS NOT NULL;
