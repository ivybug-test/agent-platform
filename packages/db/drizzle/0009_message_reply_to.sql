-- Reply / quote target on messages. Lets users disambiguate "上面那张图"
-- and quote-reply across rooms. drizzle-kit push handles the column add,
-- but the self-FK is brittle through generators — declare it here.
--
-- Idempotent: safe to re-run.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_reply_to_message_id_fk'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_reply_to_message_id_fk
      FOREIGN KEY (reply_to_message_id)
      REFERENCES messages(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;
