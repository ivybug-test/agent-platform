-- Side-channel for non-text artifacts attached to a message. For image
-- messages, the memory-worker's caption-image job writes
-- {"vision":{"caption":"...","model":"...","generatedAt":"..."}} so summary
-- and user-memory extractors can include the description in their prompts
-- once the image has scrolled out of the chat window.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS metadata jsonb;
