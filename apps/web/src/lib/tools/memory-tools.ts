import { db, userMemories, messages, users, roomMemories, userRelationships } from "@agent-platform/db";
import { and, eq, isNull, isNotNull, desc, asc, ilike, or, lt, gte, lte, inArray, ne, sql } from "drizzle-orm";
import type { ToolHandler } from "./index";
import { visibleToSubject } from "@/lib/memory-filters";
import { resolveRoomMemberByName } from "./resolvers";

const VALID_CATEGORIES = [
  "identity",
  "preference",
  "relationship",
  "event",
  "opinion",
  "context",
] as const;
const VALID_IMPORTANCES = ["high", "medium", "low"] as const;

type Category = (typeof VALID_CATEGORIES)[number];
type Importance = (typeof VALID_IMPORTANCES)[number];

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Character-bigram Jaccard similarity. Works for CJK and English alike.
 * Returns 0..1 — identical bigram multisets = 1.
 */
function textSimilarity(a: string, b: string): number {
  const bigrams = (s: string): Map<string, number> => {
    const chars = [...s.toLowerCase().replace(/\s+/g, "")];
    const map = new Map<string, number>();
    for (let i = 0; i < chars.length - 1; i++) {
      const bg = chars[i] + chars[i + 1];
      map.set(bg, (map.get(bg) || 0) + 1);
    }
    return map;
  };
  const bgA = bigrams(a);
  const bgB = bigrams(b);
  let intersection = 0;
  let union = 0;
  const allKeys = new Set([...bgA.keys(), ...bgB.keys()]);
  for (const k of allKeys) {
    const ca = bgA.get(k) || 0;
    const cb = bgB.get(k) || 0;
    intersection += Math.min(ca, cb);
    union += Math.max(ca, cb);
  }
  return union === 0 ? 0 : intersection / union;
}

function clampLimit(n: unknown, dflt: number, max: number): number {
  const v = typeof n === "number" ? Math.floor(n) : dflt;
  if (!Number.isFinite(v) || v <= 0) return dflt;
  return Math.min(v, max);
}

function esc(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

/** Accepts "YYYY-MM-DD", "YYYY-MM-DDTHH:mm", or a full ISO string. Bare dates
 *  anchor to Asia/Shanghai noon so timezone drift doesn't push them off-day. */
function parseEventAt(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T04:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// -----------------------------------------------------------------------------
// search_memories
// -----------------------------------------------------------------------------

const searchMemories: ToolHandler = async (args, ctx) => {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  const category = VALID_CATEGORIES.includes(args?.category)
    ? (args.category as Category)
    : null;
  const limit = clampLimit(args?.limit, 10, 30);
  const from = parseEventAt(args?.from);
  const to = parseEventAt(args?.to);
  const hasTimeFilter = from !== null || to !== null;

  const conditions = [
    eq(userMemories.userId, ctx.userId),
    visibleToSubject(),
  ];
  if (category) conditions.push(eq(userMemories.category, category));
  if (query) conditions.push(ilike(userMemories.content, `%${esc(query)}%`));
  if (hasTimeFilter) {
    // Restrict to rows that actually carry an event_at when the caller asked
    // for a time window — timeless facts (identity, preferences) never match.
    conditions.push(isNotNull(userMemories.eventAt));
    if (from) conditions.push(gte(userMemories.eventAt, from));
    if (to) conditions.push(lte(userMemories.eventAt, to));
  }

  const rows = await db
    .select({
      id: userMemories.id,
      content: userMemories.content,
      category: userMemories.category,
      importance: userMemories.importance,
      source: userMemories.source,
      eventAt: userMemories.eventAt,
      updatedAt: userMemories.updatedAt,
    })
    .from(userMemories)
    .where(and(...conditions))
    .orderBy(
      // When the caller filtered by time, chronological order is the useful
      // one. Otherwise keep the default importance+recency rank.
      ...(hasTimeFilter
        ? [desc(userMemories.eventAt)]
        : [desc(userMemories.importance), desc(userMemories.updatedAt)])
    )
    .limit(limit);

  // Retrieval reinforcement (Park et al. 2023): accessing a memory resets its
  // recency, so heavily-USED facts don't decay out of the pinned window just
  // because the user didn't re-state them. We bump last_reinforced_at but
  // deliberately DO NOT bump strength — strength counts how often the fact
  // was claimed, retrieval is a different signal and should only affect the
  // decay anchor. Fire-and-forget; the tool response is already composed.
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    void (async () => {
      try {
        await db
          .update(userMemories)
          .set({ lastReinforcedAt: new Date() })
          .where(inArray(userMemories.id, ids));
      } catch {}
    })();
  }

  return { results: rows };
};

// -----------------------------------------------------------------------------
// search_messages
// -----------------------------------------------------------------------------

const searchMessages: ToolHandler = async (args, ctx) => {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { error: "query is required", results: [] };
  }
  const limit = clampLimit(args?.limit, 10, 30);
  const before = parseEventAt(args?.before);
  const after = parseEventAt(args?.after);

  const conditions = [
    eq(messages.roomId, ctx.roomId),
    eq(messages.status, "completed"),
    ilike(messages.content, `%${esc(query)}%`),
  ];
  if (before) conditions.push(lt(messages.createdAt, before));
  if (after) conditions.push(gte(messages.createdAt, after));

  const rows = await db
    .select({
      id: messages.id,
      senderType: messages.senderType,
      senderId: messages.senderId,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(...conditions))
    // With an `after` bound (usually a narrow window) chronological ASC is
    // more useful; otherwise keep newest-first.
    .orderBy(after ? asc(messages.createdAt) : desc(messages.createdAt))
    .limit(limit);

  // Resolve sender display names (user name, or "Agent" for agent messages)
  const userIds = [
    ...new Set(
      rows
        .filter((r) => r.senderType === "user" && r.senderId)
        .map((r) => r.senderId as string)
    ),
  ];
  const nameMap = new Map<string, string>();
  if (userIds.length > 0) {
    const userRows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, userIds));
    for (const u of userRows) nameMap.set(u.id, u.name);
  }

  return {
    results: rows.map((r) => ({
      id: r.id,
      senderName:
        r.senderType === "agent"
          ? "Agent"
          : r.senderId
            ? nameMap.get(r.senderId) || "User"
            : "User",
      content: r.content,
      createdAt: r.createdAt,
    })),
  };
};

// -----------------------------------------------------------------------------
// remember (with built-in near-dup guard — simplified D2)
// -----------------------------------------------------------------------------

// Phase A: on a near-duplicate, REINFORCE the existing memory (bump strength +
// last_reinforced_at) instead of skipping silently. The threshold name stays
// the same to avoid churn; the action is different.
const SIMILARITY_SKIP_THRESHOLD = 0.55;

const remember: ToolHandler = async (args, ctx) => {
  const content = typeof args?.content === "string" ? args.content.trim() : "";
  const category = args?.category as Category;
  const importance = (args?.importance as Importance) || "medium";
  const subjectName =
    typeof args?.subjectName === "string" ? args.subjectName.trim() : "";
  const eventAt = parseEventAt(args?.eventAt);

  if (!content) return { error: "content required" };
  if (!VALID_CATEGORIES.includes(category)) {
    return { error: "invalid category" };
  }
  if (!VALID_IMPORTANCES.includes(importance)) {
    return { error: "invalid importance" };
  }

  // Resolve subject: default to the speaker, otherwise look up the named
  // room member.
  let subjectUserId = ctx.userId;
  const isThirdParty = subjectName.length > 0;
  if (isThirdParty) {
    const resolved = await resolveRoomMemberByName(ctx.roomId, subjectName);
    if (!resolved) {
      return {
        error: `no unique room member matches subjectName "${subjectName}"`,
      };
    }
    subjectUserId = resolved;
  }

  // Near-dup guard: compare against the SUBJECT's existing active memories
  // (including unconfirmed-but-same-author rows so a speaker can't queue the
  // same pending fact twice). Deleted rows are still excluded.
  const existing = await db
    .select({
      id: userMemories.id,
      content: userMemories.content,
      source: userMemories.source,
      authoredByUserId: userMemories.authoredByUserId,
      userId: userMemories.userId,
      confirmedAt: userMemories.confirmedAt,
    })
    .from(userMemories)
    .where(
      and(
        eq(userMemories.userId, subjectUserId),
        isNull(userMemories.deletedAt)
      )
    );

  let best: {
    id: string;
    content: string;
    sim: number;
    source: string;
    locked: boolean;
    pending: boolean;
  } | null = null;
  for (const m of existing) {
    const sim = textSimilarity(content, m.content);
    const locked = m.source === "user_explicit";
    const pending =
      m.authoredByUserId !== null &&
      m.authoredByUserId !== m.userId &&
      m.confirmedAt === null;
    if (!best || sim > best.sim) {
      best = {
        id: m.id,
        content: m.content,
        sim,
        source: m.source,
        locked,
        pending,
      };
    }
  }

  if (best && best.sim >= SIMILARITY_SKIP_THRESHOLD) {
    // Locked / pending rows can't be reinforced silently — fall back to the
    // old "skipped + surface similar" behaviour so the agent can react (e.g.
    // confirm the pending row, or tell the user the locked fact is already
    // there).
    if (best.locked || best.pending) {
      return {
        skipped: true,
        reason: best.pending
          ? "near-duplicate of a pending memory"
          : "near-duplicate of a user-locked memory",
        similar: { id: best.id, content: best.content, similarity: best.sim },
      };
    }
    const [row] = await db
      .update(userMemories)
      .set({
        strength: sql`${userMemories.strength} + 1`,
        lastReinforcedAt: new Date(),
        updatedAt: new Date(),
        // If the caller now provides an eventAt and the existing row had none,
        // fill it in — extra signal is strictly better than no signal.
        ...(eventAt ? { eventAt } : {}),
      })
      .where(eq(userMemories.id, best.id))
      .returning({
        id: userMemories.id,
        content: userMemories.content,
        category: userMemories.category,
        importance: userMemories.importance,
        strength: userMemories.strength,
        eventAt: userMemories.eventAt,
      });
    return {
      ok: true,
      reinforced: true,
      note: "Near-duplicate of an existing memory — reinforced instead of creating a new row.",
      memory: row,
      similarity: best.sim,
    };
  }

  // Third-party writes land pending (confirmed_at NULL + authored_by != user_id).
  // Self-writes land auto-confirmed (authored_by NULL).
  const [row] = await db
    .insert(userMemories)
    .values({
      userId: subjectUserId,
      content,
      category,
      importance,
      source: "extracted",
      sourceRoomId: ctx.roomId,
      authoredByUserId: isThirdParty ? ctx.userId : null,
      // pending state for third-party writes; self-writes auto-visible
      // because authoredByUserId is null (visibleToSubject ignores the
      // confirmedAt column when the row is self-authored).
      confirmedAt: null,
      eventAt: eventAt ?? undefined,
      lastReinforcedAt: new Date(),
    })
    .returning({
      id: userMemories.id,
      content: userMemories.content,
      category: userMemories.category,
      importance: userMemories.importance,
      eventAt: userMemories.eventAt,
    });

  if (isThirdParty) {
    return {
      ok: true,
      pending: true,
      note: `Saved as pending for ${subjectName}. They'll see it in their /memories "待确认" tab and can accept or reject.`,
      memory: row,
    };
  }
  return { ok: true, memory: row };
};

// -----------------------------------------------------------------------------
// update_memory (user-explicit intent expressed through chat)
// -----------------------------------------------------------------------------

const updateMemory: ToolHandler = async (args, ctx) => {
  const memoryId =
    typeof args?.memoryId === "string" ? args.memoryId.trim() : "";
  if (!memoryId) return { error: "memoryId required" };

  const patch: {
    content?: string;
    category?: Category;
    importance?: Importance;
  } = {};
  if (typeof args?.content === "string") {
    const trimmed = args.content.trim();
    if (!trimmed) return { error: "content cannot be empty" };
    patch.content = trimmed;
  }
  if (args?.category !== undefined) {
    if (!VALID_CATEGORIES.includes(args.category)) {
      return { error: "invalid category" };
    }
    patch.category = args.category as Category;
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

  // Tools can only edit rows that are already visible to the subject —
  // pending third-party rows must be confirmed (or rejected) first, not
  // silently edited through this path.
  const [row] = await db
    .update(userMemories)
    .set({
      ...patch,
      source: "user_explicit",
      lastReinforcedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userMemories.id, memoryId),
        eq(userMemories.userId, ctx.userId),
        visibleToSubject()
      )
    )
    .returning({
      id: userMemories.id,
      content: userMemories.content,
      category: userMemories.category,
      importance: userMemories.importance,
    });

  if (!row) return { error: "memory not found" };
  return { ok: true, memory: row };
};

// -----------------------------------------------------------------------------
// forget_memory
// -----------------------------------------------------------------------------

const forgetMemory: ToolHandler = async (args, ctx) => {
  const memoryId =
    typeof args?.memoryId === "string" ? args.memoryId.trim() : "";
  if (!memoryId) return { error: "memoryId required" };

  const [row] = await db
    .update(userMemories)
    .set({
      deletedAt: new Date(),
      source: "user_explicit",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userMemories.id, memoryId),
        eq(userMemories.userId, ctx.userId),
        visibleToSubject()
      )
    )
    .returning({ id: userMemories.id });

  if (!row) return { error: "memory not found" };
  return { ok: true };
};

// -----------------------------------------------------------------------------
// confirm_memory — subject accepts a pending third-party write
// -----------------------------------------------------------------------------

const confirmMemory: ToolHandler = async (args, ctx) => {
  const memoryId =
    typeof args?.memoryId === "string" ? args.memoryId.trim() : "";
  if (!memoryId) return { error: "memoryId required" };

  const [row] = await db
    .update(userMemories)
    .set({ confirmedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(userMemories.id, memoryId),
        eq(userMemories.userId, ctx.userId),
        isNull(userMemories.deletedAt),
        isNotNull(userMemories.authoredByUserId),
        ne(userMemories.authoredByUserId, userMemories.userId),
        isNull(userMemories.confirmedAt)
      )
    )
    .returning({
      id: userMemories.id,
      content: userMemories.content,
    });

  if (!row) return { error: "pending memory not found" };
  return { ok: true, memory: row };
};

// -----------------------------------------------------------------------------
// Room memories (Phase 3 of multi-user memory)
// -----------------------------------------------------------------------------

const searchRoomMemory: ToolHandler = async (args, ctx) => {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  const limit = clampLimit(args?.limit, 10, 30);

  const conditions = [
    eq(roomMemories.roomId, ctx.roomId),
    isNull(roomMemories.deletedAt),
  ];
  if (query)
    conditions.push(ilike(roomMemories.content, `%${esc(query)}%`));

  const rows = await db
    .select({
      id: roomMemories.id,
      content: roomMemories.content,
      importance: roomMemories.importance,
      source: roomMemories.source,
      updatedAt: roomMemories.updatedAt,
    })
    .from(roomMemories)
    .where(and(...conditions))
    .orderBy(desc(roomMemories.importance), desc(roomMemories.updatedAt))
    .limit(limit);

  return { results: rows };
};

const saveRoomFact: ToolHandler = async (args, ctx) => {
  const content = typeof args?.content === "string" ? args.content.trim() : "";
  const importance = (args?.importance as Importance) || "medium";
  if (!content) return { error: "content required" };
  if (!VALID_IMPORTANCES.includes(importance)) {
    return { error: "invalid importance" };
  }

  // Near-dup guard scoped to the room
  const existing = await db
    .select({ id: roomMemories.id, content: roomMemories.content })
    .from(roomMemories)
    .where(
      and(eq(roomMemories.roomId, ctx.roomId), isNull(roomMemories.deletedAt))
    );
  let best: { id: string; content: string; sim: number } | null = null;
  for (const m of existing) {
    const sim = textSimilarity(content, m.content);
    if (!best || sim > best.sim) {
      best = { id: m.id, content: m.content, sim };
    }
  }
  if (best && best.sim >= SIMILARITY_SKIP_THRESHOLD) {
    return {
      skipped: true,
      reason: "near-duplicate of an existing room fact",
      similar: { id: best.id, content: best.content, similarity: best.sim },
    };
  }

  const [row] = await db
    .insert(roomMemories)
    .values({
      roomId: ctx.roomId,
      content,
      importance,
      createdByUserId: ctx.userId,
      source: "extracted",
    })
    .returning({
      id: roomMemories.id,
      content: roomMemories.content,
      importance: roomMemories.importance,
    });
  return { ok: true, memory: row };
};

const forgetRoomFact: ToolHandler = async (args, ctx) => {
  const memoryId =
    typeof args?.memoryId === "string" ? args.memoryId.trim() : "";
  if (!memoryId) return { error: "memoryId required" };

  // Room fact: any room member can soft-delete. Lock extracted-only edits
  // so user_explicit rows (added via UI) stay put unless the UI deletes them.
  const [row] = await db
    .update(roomMemories)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(roomMemories.id, memoryId),
        eq(roomMemories.roomId, ctx.roomId),
        eq(roomMemories.source, "extracted"),
        isNull(roomMemories.deletedAt)
      )
    )
    .returning({ id: roomMemories.id });

  if (!row) return { error: "room fact not found" };
  return { ok: true };
};

// -----------------------------------------------------------------------------
// User relationships (Phase 4 of multi-user memory)
// -----------------------------------------------------------------------------

const VALID_RELATIONSHIP_KINDS = [
  "spouse",
  "family",
  "colleague",
  "friend",
  "custom",
] as const;
type RelationshipKind = (typeof VALID_RELATIONSHIP_KINDS)[number];

const relate: ToolHandler = async (args, ctx) => {
  const otherUserName =
    typeof args?.otherUserName === "string" ? args.otherUserName.trim() : "";
  const kind = args?.kind as RelationshipKind;
  const content =
    typeof args?.content === "string" ? args.content.trim() : null;

  if (!otherUserName) return { error: "otherUserName required" };
  if (!VALID_RELATIONSHIP_KINDS.includes(kind)) {
    return { error: "invalid kind" };
  }

  const otherUserId = await resolveRoomMemberByName(ctx.roomId, otherUserName);
  if (!otherUserId) {
    return { error: `no unique room member matches "${otherUserName}"` };
  }
  if (otherUserId === ctx.userId) {
    return { error: "cannot relate to yourself" };
  }

  // Canonical ordering: a_user_id < b_user_id.
  const [aId, bId] =
    ctx.userId < otherUserId
      ? [ctx.userId, otherUserId]
      : [otherUserId, ctx.userId];
  const speakerIsA = ctx.userId === aId;
  const now = new Date();

  // Upsert: find existing row first.
  const [existing] = await db
    .select()
    .from(userRelationships)
    .where(
      and(
        eq(userRelationships.aUserId, aId),
        eq(userRelationships.bUserId, bId),
        eq(userRelationships.kind, kind),
        isNull(userRelationships.deletedAt)
      )
    );

  if (existing) {
    // Update the speaker's confirmation side only.
    const patch = speakerIsA
      ? { confirmedByA: now, updatedAt: now }
      : { confirmedByB: now, updatedAt: now };
    // If content provided, update too
    if (content) (patch as any).content = content;
    const [updated] = await db
      .update(userRelationships)
      .set(patch)
      .where(eq(userRelationships.id, existing.id))
      .returning();
    return {
      ok: true,
      relationship: updated,
      fullyConfirmed:
        updated.confirmedByA !== null && updated.confirmedByB !== null,
    };
  }

  const [row] = await db
    .insert(userRelationships)
    .values({
      aUserId: aId,
      bUserId: bId,
      kind,
      content,
      confirmedByA: speakerIsA ? now : null,
      confirmedByB: speakerIsA ? null : now,
    })
    .returning();
  return {
    ok: true,
    relationship: row,
    fullyConfirmed: false,
    note: `Proposed ${kind} edge with ${otherUserName}. They'll see it in their /memories 关系 tab and can accept or reject.`,
  };
};

const searchRelationships: ToolHandler = async (args, ctx) => {
  const withUserName =
    typeof args?.withUserName === "string" ? args.withUserName.trim() : "";

  let otherId: string | null = null;
  if (withUserName) {
    otherId = await resolveRoomMemberByName(ctx.roomId, withUserName);
    if (!otherId) {
      return { error: `no unique room member matches "${withUserName}"` };
    }
  }

  const speakerInvolved = or(
    eq(userRelationships.aUserId, ctx.userId),
    eq(userRelationships.bUserId, ctx.userId)
  )!;
  const conditions = [
    speakerInvolved,
    isNull(userRelationships.deletedAt),
    isNotNull(userRelationships.confirmedByA),
    isNotNull(userRelationships.confirmedByB),
  ];
  if (otherId) {
    conditions.push(
      or(
        and(
          eq(userRelationships.aUserId, ctx.userId),
          eq(userRelationships.bUserId, otherId)
        ),
        and(
          eq(userRelationships.aUserId, otherId),
          eq(userRelationships.bUserId, ctx.userId)
        )
      )!
    );
  }

  const rows = await db
    .select({
      id: userRelationships.id,
      aUserId: userRelationships.aUserId,
      bUserId: userRelationships.bUserId,
      kind: userRelationships.kind,
      content: userRelationships.content,
    })
    .from(userRelationships)
    .where(and(...conditions));

  // Resolve the other side's name for each row.
  const otherIds = [
    ...new Set(
      rows.map((r) => (r.aUserId === ctx.userId ? r.bUserId : r.aUserId))
    ),
  ];
  const nameRows =
    otherIds.length > 0
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, otherIds))
      : [];
  const nameMap = new Map(nameRows.map((u) => [u.id, u.name]));

  return {
    results: rows.map((r) => ({
      id: r.id,
      otherUserName:
        nameMap.get(r.aUserId === ctx.userId ? r.bUserId : r.aUserId) || "?",
      kind: r.kind,
      content: r.content,
    })),
  };
};

const unrelate: ToolHandler = async (args, ctx) => {
  const relationshipId =
    typeof args?.relationshipId === "string"
      ? args.relationshipId.trim()
      : "";
  if (!relationshipId) return { error: "relationshipId required" };

  const [row] = await db
    .update(userRelationships)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(userRelationships.id, relationshipId),
        or(
          eq(userRelationships.aUserId, ctx.userId),
          eq(userRelationships.bUserId, ctx.userId)
        )!,
        isNull(userRelationships.deletedAt)
      )
    )
    .returning({ id: userRelationships.id });

  if (!row) return { error: "relationship not found" };
  return { ok: true };
};

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

export const memoryToolHandlers: Record<string, ToolHandler> = {
  search_memories: searchMemories,
  search_messages: searchMessages,
  remember,
  update_memory: updateMemory,
  forget_memory: forgetMemory,
  confirm_memory: confirmMemory,
  search_room_memory: searchRoomMemory,
  save_room_fact: saveRoomFact,
  forget_room_fact: forgetRoomFact,
  relate,
  search_relationships: searchRelationships,
  unrelate,
};

// OpenAI-shaped tool definitions — passed to agent-runtime in the /chat body.
export const memoryToolDefs = [
  {
    type: "function" as const,
    function: {
      name: "search_memories",
      description:
        "Search the current user's stored long-term memories (facts, preferences, relationships, events, etc.). Use when you suspect there's a relevant fact not in the pinned list. Pass from/to to retrieve memories whose event_at falls in a specific window — great for 'what happened last week' style questions.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Substring to match against memory content (case-insensitive). Leave empty to list by other filters alone.",
          },
          category: {
            type: "string",
            enum: [...VALID_CATEGORIES],
            description: "Restrict to one category.",
          },
          from: {
            type: "string",
            description:
              "ISO8601 date or datetime — inclusive lower bound on the memory's event_at. Use with/without `to`. Implicitly filters out timeless memories (those without event_at).",
          },
          to: {
            type: "string",
            description:
              "ISO8601 date or datetime — inclusive upper bound on the memory's event_at.",
          },
          limit: {
            type: "integer",
            description: "Max results (1–30). Default 10.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_messages",
      description:
        "Search completed messages in the current room by substring. Use when the user references something said earlier that isn't in the recent window.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Substring to match (case-insensitive).",
          },
          limit: {
            type: "integer",
            description: "Max results (1–30). Default 10.",
          },
          before: {
            type: "string",
            description:
              "ISO timestamp — only return messages strictly earlier than this.",
          },
          after: {
            type: "string",
            description:
              "ISO timestamp — only return messages at or after this. Combine with `before` for a time window.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "remember",
      description:
        "Store a new long-term fact. Default subject is the current speaker; pass subjectName to record a fact about another room member (such writes land pending until the subject accepts them in their /memories tab). Near-duplicates of the subject's existing active memories REINFORCE the existing row (bump strength) instead of creating a new one.",
      parameters: {
        type: "object",
        required: ["content", "category", "importance"],
        properties: {
          subjectName: {
            type: "string",
            description:
              "Optional. The display name of another room member this fact is about. Omit to save against the current speaker. Use sparingly — the other user will need to accept or reject the pending entry.",
          },
          content: {
            type: "string",
            description:
              'Third-person single-sentence fact, written in the SAME LANGUAGE the user is speaking (Chinese input → Chinese fact, English input → English fact, do not translate). MUST NOT contain relative time phrases like "今天" / "刚才" / "yesterday" — always resolve them to absolute dates using the Current time layer in the system prompt. Example: "住在深圳" / "Lives in Shenzhen" / "2026-04-19 没吃午饭".',
          },
          category: {
            type: "string",
            enum: [...VALID_CATEGORIES],
          },
          importance: {
            type: "string",
            enum: [...VALID_IMPORTANCES],
          },
          eventAt: {
            type: "string",
            description:
              'Optional ISO8601 date/datetime of when the event happened. Pass this whenever the fact describes a specific point in time (events, "skipped lunch today", "went to Shanghai", etc). Omit for timeless facts (identity, general preferences, relationships). Example: "2026-04-19" or "2026-04-19T12:30+08:00".',
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_memory",
      description:
        "Correct an existing memory. Call this when the user explicitly corrects a fact the agent remembers. The memory becomes user-locked and will not be touched by background extraction.",
      parameters: {
        type: "object",
        required: ["memoryId"],
        properties: {
          memoryId: { type: "string" },
          content: { type: "string" },
          category: { type: "string", enum: [...VALID_CATEGORIES] },
          importance: { type: "string", enum: [...VALID_IMPORTANCES] },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "forget_memory",
      description:
        "Soft-delete a memory so it's no longer used and the background extractor cannot re-create it. Call this when the user explicitly asks to forget something.",
      parameters: {
        type: "object",
        required: ["memoryId"],
        properties: {
          memoryId: { type: "string" },
          reason: {
            type: "string",
            description: "Optional reason for logging.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "confirm_memory",
      description:
        "Accept a pending third-party memory as true. Only works on rows authored by someone other than the current speaker that haven't been confirmed yet. Call this when the current speaker says something like '对,没错' / 'yes that's correct' in response to a fact the agent read out from their 待确认 queue.",
      parameters: {
        type: "object",
        required: ["memoryId"],
        properties: {
          memoryId: { type: "string" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_room_memory",
      description:
        "Search facts that belong to the current ROOM (shared across all members — project codenames, group focus, etc), not tied to any single user.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Substring to match against room fact content (case-insensitive).",
          },
          limit: {
            type: "integer",
            description: "Max results (1–30). Default 10.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "save_room_fact",
      description:
        "Store a fact about the current room itself — something every member should know (project name, ongoing initiative, shared agreement). Write in the user's language. Near-duplicates are auto-skipped.",
      parameters: {
        type: "object",
        required: ["content", "importance"],
        properties: {
          content: { type: "string" },
          importance: {
            type: "string",
            enum: [...VALID_IMPORTANCES],
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "forget_room_fact",
      description:
        "Soft-delete a room fact. Any room member's agent can call this. Works on rows the agent itself added (source=extracted); user-added rows (source=user_explicit) must be deleted from the room settings UI.",
      parameters: {
        type: "object",
        required: ["memoryId"],
        properties: {
          memoryId: { type: "string" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "relate",
      description:
        "Propose or confirm a typed relationship edge between the current speaker and another room member. Both sides must eventually confirm for the edge to be active and shown to the agent in future chats.",
      parameters: {
        type: "object",
        required: ["otherUserName", "kind"],
        properties: {
          otherUserName: {
            type: "string",
            description:
              "The display name of the other room member. Must match exactly (case-insensitive).",
          },
          kind: {
            type: "string",
            enum: [...VALID_RELATIONSHIP_KINDS],
          },
          content: {
            type: "string",
            description:
              "Optional extra detail, e.g. '认识 10 年' / 'met in college'.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_relationships",
      description:
        "List the current speaker's active (both-sides-confirmed) relationships. Optionally narrow to a specific other member.",
      parameters: {
        type: "object",
        properties: {
          withUserName: {
            type: "string",
            description:
              "If set, only return the relationship with this specific room member.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "unrelate",
      description:
        "Soft-delete a relationship edge. Either side of the edge can remove it.",
      parameters: {
        type: "object",
        required: ["relationshipId"],
        properties: {
          relationshipId: { type: "string" },
        },
      },
    },
  },
];
