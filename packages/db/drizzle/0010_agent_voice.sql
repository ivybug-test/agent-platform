-- Per-agent voice settings for TTS playback. NULL across all three columns
-- = use the default voice from the active TTS provider. The frontend's
-- "voice mode" toggle decides WHEN to play; these columns decide WHO sounds.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS voice_provider varchar(20);
--> statement-breakpoint
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS voice_id varchar(100);
--> statement-breakpoint
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS voice_name varchar(60);
