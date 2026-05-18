-- M1 of memory-system Phase α: enable pgvector and add embedding columns.
--
--   Semantic retrieval + semantic dedup require dense embeddings on every
--   memory and message row. text-embedding-3-small produces 1536-dim
--   vectors (matches schema.ts). HNSW (Hierarchical Navigable Small World)
--   is the standard ANN index — m=16/ef_construction=64 are the pgvector
--   docs' defaults and work well up to ~10M vectors.
--
-- Idempotent — safe to re-run against a DB that already has the columns or
-- the extension installed.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint

ALTER TABLE user_memories
  ADD COLUMN IF NOT EXISTS embedding vector(1536);
--> statement-breakpoint
ALTER TABLE room_memories
  ADD COLUMN IF NOT EXISTS embedding vector(1536);
--> statement-breakpoint
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS embedding vector(1536);
--> statement-breakpoint

-- HNSW indexes using cosine distance (vector_cosine_ops). Cosine is the
-- standard for normalized embeddings from OpenAI. Indexes are built
-- concurrently is not possible inside a transaction; the migration runner
-- wraps statements in a tx, so we use the non-concurrent form. Volume is
-- small (<100k rows in MVP) so the build is fast.
CREATE INDEX IF NOT EXISTS user_memories_embedding_idx
  ON user_memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS room_memories_embedding_idx
  ON room_memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS messages_embedding_idx
  ON messages USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
