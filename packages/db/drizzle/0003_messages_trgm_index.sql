-- Enable pg_trgm so ILIKE '%q%' on messages.content can be index-accelerated
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
-- Partial GIN index: only completed messages (agents can't search streaming/failed)
CREATE INDEX IF NOT EXISTS messages_content_trgm_idx
  ON messages
  USING GIN (content gin_trgm_ops)
  WHERE status = 'completed';
