-- Phase 2 of multi-user memory: separate "who wrote it" (authored_by_user_id)
-- from "who it's about" (user_id), plus a per-row confirmation timestamp so
-- third-party writes can wait for the subject's approval.
ALTER TABLE user_memories
  ADD COLUMN IF NOT EXISTS authored_by_user_id uuid REFERENCES users(id);
--> statement-breakpoint
ALTER TABLE user_memories
  ADD COLUMN IF NOT EXISTS confirmed_at timestamp;
--> statement-breakpoint
-- Partial index serving the "待确认" listing per subject: rows where the
-- subject (user_id) received a third-party write that hasn't been confirmed.
CREATE INDEX IF NOT EXISTS user_memories_pending_idx
  ON user_memories (user_id)
  WHERE deleted_at IS NULL
    AND authored_by_user_id IS NOT NULL
    AND confirmed_at IS NULL;
