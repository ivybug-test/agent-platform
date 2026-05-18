-- M3 of memory-system Phase α: agent self-memory table.
--
-- Until now, memory has been about USERS (user_memories) or ROOMS
-- (room_memories) or USER-USER edges (user_relationships). The agent
-- itself had no memory dimension — its identity was a fixed
-- agents.system_prompt string, its behaviour patterns weren't tracked,
-- and any "world knowledge" it picked up from one conversation
-- couldn't be reused in another.
--
-- agent_memories holds four kinds:
--   - persona       — declared identity / values / style. Always-pinned.
--                     User-locked by default (admin edits via /agent UI).
--   - self_tendency — behavioural patterns the agent learned about
--                     itself ("我之前对甲用户解释太冗余"). Worker auto-
--                     extracts these from the agent's own assistant
--                     messages on a daily cadence.
--   - world         — cross-room, non-user-specific facts the agent has
--                     internalised ("Doubao 出了新模型 V4"). MVP: retrieved
--                     by semantic search to current turn (deferred to M4
--                     retrieval pipeline); for now just stored + queryable.
--   - narrative     — autobiographical paragraph PER (agent, user) or
--                     (agent, room). The "story of our relationship".
--                     Sleep-time agent rewrites it periodically. Source:
--                     Sophia (arxiv 2512.18202) + Persistent Identity
--                     Multi-Anchor (arxiv 2604.09588).
--
-- Scope semantics:
--   - persona/self_tendency/world  → scope_user_id NULL AND scope_room_id NULL
--   - narrative                    → at least one of (scope_user_id, scope_room_id) NOT NULL
-- Enforced by CHECK constraint below.
--
-- Provenance (source_message_ids / evidence_quote) and decay (strength /
-- last_reinforced_at) mirror user_memories so the same RULE 11 grounding
-- discipline applies.

CREATE TABLE IF NOT EXISTS agent_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id),
  kind varchar(20) NOT NULL,
  content text NOT NULL,
  -- Scope (semantics depend on kind, see CHECK below)
  scope_user_id uuid REFERENCES users(id),
  scope_room_id uuid REFERENCES rooms(id),
  -- Importance / lifecycle
  importance memory_importance NOT NULL DEFAULT 'medium',
  source memory_source NOT NULL DEFAULT 'extracted',
  confidence real NOT NULL DEFAULT 1.0,
  strength real NOT NULL DEFAULT 1.0,
  last_reinforced_at timestamp,
  -- Provenance
  source_message_ids jsonb,
  evidence_quote text,
  -- Retrieval
  embedding vector(1536),
  -- Lifecycle
  deleted_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  -- Kind-scope consistency
  CONSTRAINT agent_memories_kind_scope_chk CHECK (
    (kind = 'narrative' AND (scope_user_id IS NOT NULL OR scope_room_id IS NOT NULL))
    OR
    (kind IN ('persona', 'self_tendency', 'world') AND scope_user_id IS NULL AND scope_room_id IS NULL)
  )
);
--> statement-breakpoint

-- Active-row lookup for pinned injection (per agent, per kind).
CREATE INDEX IF NOT EXISTS agent_memories_active_idx
  ON agent_memories (agent_id, kind, updated_at DESC)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

-- Narrative lookup by (agent, scope_user) or (agent, scope_room).
CREATE INDEX IF NOT EXISTS agent_memories_narrative_user_idx
  ON agent_memories (agent_id, scope_user_id)
  WHERE deleted_at IS NULL AND kind = 'narrative' AND scope_user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_memories_narrative_room_idx
  ON agent_memories (agent_id, scope_room_id)
  WHERE deleted_at IS NULL AND kind = 'narrative' AND scope_room_id IS NOT NULL;
--> statement-breakpoint

-- HNSW on embedding for semantic retrieval (mainly for `world` kind in M4+).
CREATE INDEX IF NOT EXISTS agent_memories_embedding_idx
  ON agent_memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
