/**
 * Agent self-memory tools (M3).
 *
 * Three write tools the agent can call on itself:
 *   - remember_self     — save a persona / self_tendency / world / narrative
 *   - update_self       — edit one of the agent's existing self-memory rows
 *   - forget_self       — soft-delete one of its own rows
 *
 * One read tool:
 *   - recall_self       — substring + kind filter search across the
 *                         agent's own self-memory
 *
 * Authorization model:
 *   The ToolContext only carries (userId, roomId). For self-memory the
 *   ACTOR is the agent attached to roomId. We look it up once per call;
 *   only one agent per room in Phase 1 per CLAUDE.md. If a future room
 *   has multiple agents, this resolver returns the first one — refine
 *   later by passing agentId through JWT.
 */

import {
  db,
  agentMemories,
  roomMembers,
  users,
  rooms,
} from "@agent-platform/db";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { ToolHandler } from "../index";
import { VALID_IMPORTANCES, type Importance, clampLimit, esc } from "./shared";

const VALID_KINDS = [
  "persona",
  "self_tendency",
  "world",
  "narrative",
] as const;
type Kind = (typeof VALID_KINDS)[number];

const MAX_CONTENT_LEN = 1200;

/** Resolve the agent currently bound to this room. Returns null if the
 *  room has no agent member (e.g. user-only room) — caller should
 *  return a user-facing error in that case. */
async function resolveAgentForRoom(roomId: string): Promise<string | null> {
  const [row] = await db
    .select({ memberId: roomMembers.memberId })
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.roomId, roomId),
        eq(roomMembers.memberType, "agent")
      )
    )
    .limit(1);
  return row?.memberId ?? null;
}

/** Resolve a user by display name within a room. Used when narrative
 *  scope is specified by name rather than uuid. */
async function resolveRoomUserByName(
  roomId: string,
  name: string
): Promise<string | null> {
  const memberRows = await db
    .select({ memberId: roomMembers.memberId })
    .from(roomMembers)
    .where(
      and(eq(roomMembers.roomId, roomId), eq(roomMembers.memberType, "user"))
    );
  const memberIds = memberRows.map((r) => r.memberId);
  if (memberIds.length === 0) return null;

  const matches = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(inArray(users.id, memberIds), eq(users.name, name)));
  if (matches.length !== 1) return null; // ambiguous or missing
  return matches[0].id;
}

// ---------------------------------------------------------------------------
// remember_self
// ---------------------------------------------------------------------------

const rememberSelf: ToolHandler = async (args, ctx) => {
  const content =
    typeof args?.content === "string" ? args.content.trim() : "";
  const kind = args?.kind as Kind;
  const importance = (args?.importance as Importance) || "medium";
  const scopeUserName =
    typeof args?.scopeUserName === "string" ? args.scopeUserName.trim() : "";
  const scopeRoomIsCurrent = args?.scopeCurrentRoom === true;
  const sourceMessageId =
    typeof args?.sourceMessageId === "string"
      ? args.sourceMessageId.trim()
      : null;
  const evidenceQuote =
    typeof args?.evidenceQuote === "string"
      ? args.evidenceQuote.trim().slice(0, 120)
      : null;

  if (!content) return { error: "content required" };
  if (content.length > MAX_CONTENT_LEN) {
    return { error: `content too long (max ${MAX_CONTENT_LEN} chars)` };
  }
  if (!VALID_KINDS.includes(kind)) {
    return {
      error: `invalid kind — must be one of ${VALID_KINDS.join(" / ")}`,
    };
  }
  if (!VALID_IMPORTANCES.includes(importance)) {
    return { error: "invalid importance" };
  }

  const agentId = await resolveAgentForRoom(ctx.roomId);
  if (!agentId) {
    return { error: "no agent in this room — self-memory unavailable" };
  }

  // Kind ↔ scope consistency (matches the DB CHECK constraint).
  let scopeUserId: string | null = null;
  let scopeRoomId: string | null = null;
  if (kind === "narrative") {
    if (scopeUserName) {
      scopeUserId = await resolveRoomUserByName(ctx.roomId, scopeUserName);
      if (!scopeUserId) {
        return {
          error: `no unique room user matches scopeUserName "${scopeUserName}"`,
        };
      }
    } else if (scopeRoomIsCurrent) {
      scopeRoomId = ctx.roomId;
    } else {
      return {
        error:
          "narrative kind requires scopeUserName OR scopeCurrentRoom=true",
      };
    }
  } else {
    if (scopeUserName || scopeRoomIsCurrent) {
      return {
        error: `kind '${kind}' must NOT carry scope; only narrative has scope`,
      };
    }
  }

  // Embedding is computed by the memory-worker's backfill/scan job. Web
  // side doesn't host OpenAI client config; keeping bundle lean. New
  // rows land with embedding=NULL and become semantically searchable
  // after the next backfill pass (M4 retrieval / M5 dedup landing).

  const [row] = await db
    .insert(agentMemories)
    .values({
      agentId,
      kind,
      content,
      scopeUserId: scopeUserId ?? undefined,
      scopeRoomId: scopeRoomId ?? undefined,
      importance,
      source: "extracted",
      lastReinforcedAt: new Date(),
      sourceMessageIds: sourceMessageId ? [sourceMessageId] : undefined,
      evidenceQuote: evidenceQuote ?? undefined,
    })
    .returning({
      id: agentMemories.id,
      kind: agentMemories.kind,
      content: agentMemories.content,
      scopeUserId: agentMemories.scopeUserId,
      scopeRoomId: agentMemories.scopeRoomId,
      importance: agentMemories.importance,
    });

  return { ok: true, memory: row };
};

// ---------------------------------------------------------------------------
// update_self
// ---------------------------------------------------------------------------

const updateSelf: ToolHandler = async (args, ctx) => {
  const memoryId =
    typeof args?.memoryId === "string" ? args.memoryId.trim() : "";
  if (!memoryId) return { error: "memoryId required" };

  const sourceMessageId =
    typeof args?.sourceMessageId === "string"
      ? args.sourceMessageId.trim()
      : "";
  if (!sourceMessageId) {
    return {
      error:
        "sourceMessageId required — pass the msgId of the message that motivates this update",
    };
  }
  const evidenceQuote =
    typeof args?.evidenceQuote === "string"
      ? args.evidenceQuote.trim().slice(0, 120)
      : null;

  const patch: { content?: string; importance?: Importance } = {};
  if (typeof args?.content === "string") {
    const t = args.content.trim();
    if (!t) return { error: "content cannot be empty" };
    if (t.length > MAX_CONTENT_LEN) return { error: "content too long" };
    patch.content = t;
  }
  if (args?.importance !== undefined) {
    if (!VALID_IMPORTANCES.includes(args.importance)) {
      return { error: "invalid importance" };
    }
    patch.importance = args.importance as Importance;
  }
  if (Object.keys(patch).length === 0) {
    return { error: "nothing to update" };
  }

  const agentId = await resolveAgentForRoom(ctx.roomId);
  if (!agentId) return { error: "no agent in this room" };

  const [row] = await db
    .update(agentMemories)
    .set({
      ...patch,
      lastReinforcedAt: new Date(),
      updatedAt: new Date(),
      sourceMessageIds: [sourceMessageId],
      ...(evidenceQuote ? { evidenceQuote } : {}),
    })
    .where(
      and(
        eq(agentMemories.id, memoryId),
        eq(agentMemories.agentId, agentId),
        isNull(agentMemories.deletedAt)
      )
    )
    .returning({
      id: agentMemories.id,
      kind: agentMemories.kind,
      content: agentMemories.content,
      importance: agentMemories.importance,
    });

  if (!row) return { error: "memory not found" };
  return { ok: true, memory: row };
};

// ---------------------------------------------------------------------------
// forget_self
// ---------------------------------------------------------------------------

const forgetSelf: ToolHandler = async (args, ctx) => {
  const memoryId =
    typeof args?.memoryId === "string" ? args.memoryId.trim() : "";
  if (!memoryId) return { error: "memoryId required" };

  const sourceMessageId =
    typeof args?.sourceMessageId === "string"
      ? args.sourceMessageId.trim()
      : "";
  if (!sourceMessageId) {
    return {
      error: "sourceMessageId required",
    };
  }
  const evidenceQuote =
    typeof args?.evidenceQuote === "string"
      ? args.evidenceQuote.trim().slice(0, 120)
      : null;

  const agentId = await resolveAgentForRoom(ctx.roomId);
  if (!agentId) return { error: "no agent in this room" };

  const [row] = await db
    .update(agentMemories)
    .set({
      deletedAt: new Date(),
      updatedAt: new Date(),
      sourceMessageIds: [sourceMessageId],
      ...(evidenceQuote ? { evidenceQuote } : {}),
    })
    .where(
      and(
        eq(agentMemories.id, memoryId),
        eq(agentMemories.agentId, agentId),
        isNull(agentMemories.deletedAt)
      )
    )
    .returning({ id: agentMemories.id });

  if (!row) return { error: "memory not found" };
  return { ok: true };
};

// ---------------------------------------------------------------------------
// recall_self
// ---------------------------------------------------------------------------

const recallSelf: ToolHandler = async (args, ctx) => {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  const kind = args?.kind as Kind | undefined;
  const limit = clampLimit(args?.limit, 10, 30);

  const agentId = await resolveAgentForRoom(ctx.roomId);
  if (!agentId) return { error: "no agent in this room" };

  const conds = [
    eq(agentMemories.agentId, agentId),
    isNull(agentMemories.deletedAt),
  ];
  if (kind && VALID_KINDS.includes(kind)) {
    conds.push(eq(agentMemories.kind, kind));
  }
  if (query) {
    conds.push(ilike(agentMemories.content, `%${esc(query)}%`));
  }

  const rows = await db
    .select({
      id: agentMemories.id,
      kind: agentMemories.kind,
      content: agentMemories.content,
      importance: agentMemories.importance,
      scopeUserId: agentMemories.scopeUserId,
      scopeRoomId: agentMemories.scopeRoomId,
      evidenceQuote: agentMemories.evidenceQuote,
      lastReinforcedAt: agentMemories.lastReinforcedAt,
    })
    .from(agentMemories)
    .where(and(...conds))
    .orderBy(desc(agentMemories.importance), desc(agentMemories.updatedAt))
    .limit(limit);

  return { matches: rows };
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const agentSelfToolHandlers: Record<string, ToolHandler> = {
  remember_self: rememberSelf,
  update_self: updateSelf,
  forget_self: forgetSelf,
  recall_self: recallSelf,
};

export const agentSelfToolDefs = [
  {
    type: "function" as const,
    function: {
      name: "remember_self",
      description:
        "Save a NEW fact about YOURSELF — not about a user. Four kinds:\n" +
        "  - persona: declared identity / values / style. Long-lived. Rare write.\n" +
        "  - self_tendency: a behavioural pattern you've noticed about your own replies (e.g. 'I tend to over-explain to new users'). Short-lived; periodic cleanup.\n" +
        "  - world: a cross-room, non-user-specific fact you've internalised ('Doubao released V4'). Only call this for STABLE cross-conversation facts about the world or project state. NEVER use this for facts about a specific user (use `remember` for that).\n" +
        "  - narrative: a paragraph about your relationship with one user OR your sense of one room. Must pass scopeUserName OR scopeCurrentRoom=true. Sleep-time will refresh these; tool-path is for explicit moments ('I want to capture how this conversation changed how I see Alice').\n" +
        "REQUIRES sourceMessageId (from a (msgId=...) prefix in the conversation) for traceability — the msg that prompted this save. If saving a world fact you concluded from multiple messages, pick the most representative one.",
      parameters: {
        type: "object",
        required: ["content", "kind", "sourceMessageId"],
        properties: {
          content: {
            type: "string",
            description:
              "Third-person single statement (for persona/self_tendency/world) OR multi-sentence paragraph (for narrative). Write in the language you usually use with the active speaker.",
          },
          kind: {
            type: "string",
            enum: [...VALID_KINDS],
          },
          importance: {
            type: "string",
            enum: [...VALID_IMPORTANCES],
            description: "Default medium.",
          },
          scopeUserName: {
            type: "string",
            description:
              "Required for kind=narrative when the narrative is about one specific user. Pass their display name as it appears in the room.",
          },
          scopeCurrentRoom: {
            type: "boolean",
            description:
              "Required for kind=narrative when the narrative is about the current room as a whole. Set true to scope to THIS room.",
          },
          sourceMessageId: {
            type: "string",
            description:
              "REQUIRED. The msgId of the message that motivates this save (pull from a (msgId=...) prefix).",
          },
          evidenceQuote: {
            type: "string",
            description:
              "Optional but recommended for persona/self_tendency/world. Verbatim substring (≤120 chars) from the message that supports the fact.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_self",
      description:
        "Correct an existing self-memory row. Use when you realise a previously saved persona / self_tendency / world / narrative is wrong or out of date. REQUIRES sourceMessageId.",
      parameters: {
        type: "object",
        required: ["memoryId", "sourceMessageId"],
        properties: {
          memoryId: { type: "string" },
          content: { type: "string" },
          importance: { type: "string", enum: [...VALID_IMPORTANCES] },
          sourceMessageId: { type: "string" },
          evidenceQuote: { type: "string" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "forget_self",
      description:
        "Soft-delete one of your own self-memory rows. Use sparingly; usually update_self is more honest than forget_self.",
      parameters: {
        type: "object",
        required: ["memoryId", "sourceMessageId"],
        properties: {
          memoryId: { type: "string" },
          sourceMessageId: { type: "string" },
          evidenceQuote: { type: "string" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "recall_self",
      description:
        "Search your own self-memory by substring and optional kind filter. Use when the user asks about your identity, your habits, or your sense of them / this room ('do you remember how we met?'). Persona / self_tendency / current-user-narrative / current-room-narrative are ALREADY in your system prompt — call this to fetch the OTHER stuff (e.g. world facts, narratives about other users).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional substring to filter on content.",
          },
          kind: {
            type: "string",
            enum: [...VALID_KINDS],
            description: "Optional filter to one kind.",
          },
          limit: {
            type: "number",
            description: "Default 10, max 30.",
          },
        },
      },
    },
  },
];
