-- M1 of memory-system Phase α: provenance columns on user_memories and
-- room_memories.
--
--   source_message_ids — jsonb array of message uuids the extractor cited
--                        as evidence for this fact. Lets us answer "where
--                        did you learn this?" and refuse to assert facts
--                        without a citation.
--   evidence_quote     — a verbatim substring (≤120 chars) from one of
--                        those messages. Validated at write time against
--                        the actual message text — fabrications get
--                        rejected before they hit the DB.
--   confidence         — extractor's confidence 0..1. Defaults to 1.0 for
--                        backward compat with rows that pre-date this
--                        migration. Used to downweight uncertain facts in
--                        retrieval scoring.
--   kind               — distinguishes raw extracted "fact" rows from
--                        synthesised "reflection" rows produced by the
--                        reflection job. Reflections also fill
--                        source_message_ids with the *memory* ids that
--                        underlie the synthesis (jsonb is heterogeneous).
--
-- All columns NULLable so the migration is non-breaking. The extractor's
-- evidence requirement is enforced in application code, not by SQL.
ALTER TABLE user_memories
  ADD COLUMN IF NOT EXISTS source_message_ids jsonb;
--> statement-breakpoint
ALTER TABLE user_memories
  ADD COLUMN IF NOT EXISTS evidence_quote text;
--> statement-breakpoint
ALTER TABLE user_memories
  ADD COLUMN IF NOT EXISTS confidence real NOT NULL DEFAULT 1.0;
--> statement-breakpoint
ALTER TABLE user_memories
  ADD COLUMN IF NOT EXISTS kind varchar(20) NOT NULL DEFAULT 'fact';
--> statement-breakpoint

ALTER TABLE room_memories
  ADD COLUMN IF NOT EXISTS source_message_ids jsonb;
--> statement-breakpoint
ALTER TABLE room_memories
  ADD COLUMN IF NOT EXISTS evidence_quote text;
--> statement-breakpoint
ALTER TABLE room_memories
  ADD COLUMN IF NOT EXISTS confidence real NOT NULL DEFAULT 1.0;
