-- Cross-room mood state per (agent, user). Self/Favor evolve via incremental
-- formulas; row absence = defaults (60 / 50). See packages/db/src/schema.ts
-- and docs/agent_mood_design.md for semantics.
CREATE TABLE IF NOT EXISTS agent_user_moods (
  agent_id uuid NOT NULL REFERENCES agents(id),
  user_id uuid NOT NULL REFERENCES users(id),
  self_state integer NOT NULL DEFAULT 60,
  favor integer NOT NULL DEFAULT 50,
  updated_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, user_id)
);
--> statement-breakpoint

-- Raw attitude audit log. accumulating strength_sum + event_count lets us
-- inspect "this user yelled at the assistant 17 times" without rebuilding
-- Self/Favor (mood is updated incrementally elsewhere).
CREATE TABLE IF NOT EXISTS agent_user_attitude_counters (
  agent_id uuid NOT NULL REFERENCES agents(id),
  user_id uuid NOT NULL REFERENCES users(id),
  attitude varchar(16) NOT NULL,
  target varchar(16) NOT NULL,
  strength_sum integer NOT NULL DEFAULT 0,
  event_count integer NOT NULL DEFAULT 0,
  updated_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, user_id, attitude, target)
);
