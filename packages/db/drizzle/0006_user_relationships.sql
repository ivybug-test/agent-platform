-- Phase 4 of multi-user memory: typed edges between two users (spouse,
-- colleague, friend, family, custom). Both sides must confirm before the
-- edge is "active" and fed to the agent prompt.
-- a_user_id < b_user_id is a CHECK constraint so each pair+kind has
-- exactly one row regardless of who proposes; whoever proposes first has
-- their side of confirmed_by_* filled in.
CREATE TABLE IF NOT EXISTS user_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  a_user_id uuid NOT NULL REFERENCES users(id),
  b_user_id uuid NOT NULL REFERENCES users(id),
  kind varchar(40) NOT NULL,
  content text,
  confirmed_by_a timestamp,
  confirmed_by_b timestamp,
  deleted_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT user_relationships_canonical_order CHECK (a_user_id < b_user_id),
  CONSTRAINT user_relationships_unique_edge UNIQUE (a_user_id, b_user_id, kind)
);
--> statement-breakpoint
-- Fast lookup of edges involving a given user (either side).
CREATE INDEX IF NOT EXISTS user_relationships_a_idx
  ON user_relationships (a_user_id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_relationships_b_idx
  ON user_relationships (b_user_id) WHERE deleted_at IS NULL;
