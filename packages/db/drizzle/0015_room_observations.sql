-- M4.1 of memory-system Phase α: observation log.
--
-- Inspired by Mastra Observational Memory (2026-02) and Karpathy LLM Wiki
-- (2026-04). The idea: instead of replacing the previous summary each
-- time (lossy compression), we APPEND a "dated observations" block that
-- describes what happened in a recent window of messages. The full log
-- is rendered into the system prompt as a single time-ordered block,
-- which is prompt-cache friendly (stable prefix) and gives the agent
-- the "narrative continuity" that atomic-fact memory by itself lacks.
--
-- Coexists with room_summaries (legacy) — both are loaded into the
-- prompt for M4.1. M4.2/M5 may deprecate room_summaries once
-- observation log proves itself.
--
-- Trigger model (volume-based, M4.1):
--   - chat route enqueues a "room-observation" job on every message.
--   - worker reads since the latest observation's period_end and
--     measures total char volume. If > ROOM_OBSERVATION_THRESHOLD_CHARS
--     (default ~30k chars ≈ ~30k tokens), generates an observation and
--     appends. Otherwise skips silently.
--   - M4.2 will add an idle-time trigger (user-idle 30min cron).

CREATE TABLE IF NOT EXISTS room_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id),
  -- The observation text the LLM produced. Format is loose but typically
  -- bullet lines with timestamps: "- 2026-05-15 14:30 用户发了一张布偶猫
  -- 的图,告诉我这是他养的猫'邦邦'".
  content text NOT NULL,
  -- The window of messages folded into this observation. Inclusive on
  -- both ends. The next run picks up from period_end + 1 microsecond
  -- (in practice we query > period_end).
  period_start timestamp NOT NULL,
  period_end timestamp NOT NULL,
  message_count integer NOT NULL DEFAULT 0,
  -- Rough char count of the source messages — for triggering the next
  -- observation, we compare new-chars-since-period_end vs the threshold.
  source_char_count integer,
  created_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Primary lookup: latest observation per room (read path + worker
-- "what's covered so far" check).
CREATE INDEX IF NOT EXISTS room_observations_room_period_idx
  ON room_observations (room_id, period_end DESC);
