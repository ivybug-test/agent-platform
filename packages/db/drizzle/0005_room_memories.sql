-- Phase 3 of multi-user memory: facts that belong to the ROOM, shared by
-- every member, editable by anyone in the room. Distinct from user_memories
-- (per-subject) and room_summaries (disposable conversation summary).
CREATE TABLE IF NOT EXISTS room_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id),
  content text NOT NULL,
  importance memory_importance NOT NULL DEFAULT 'medium',
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  source memory_source NOT NULL DEFAULT 'extracted',
  deleted_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Partial index for the common read path: active facts of a given room,
-- ordered by importance + recency.
CREATE INDEX IF NOT EXISTS room_memories_active_idx
  ON room_memories (room_id, importance, updated_at DESC)
  WHERE deleted_at IS NULL;
