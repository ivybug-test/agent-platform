import { db, userMemories, messages, users } from "@agent-platform/db";
import {
  and,
  eq,
  isNull,
  isNotNull,
  desc,
  asc,
  ilike,
  lt,
  gte,
  lte,
  inArray,
  ne,
  sql,
} from "drizzle-orm";
import type { ToolHandler } from "../index";
import { visibleToSubject } from "@/lib/memory-filters";
import { resolveRoomMemberByName } from "../resolvers";
import { textSimilarity } from "@/lib/text-similarity";
import {
  VALID_CATEGORIES,
  VALID_IMPORTANCES,
  SIMILARITY_SKIP_THRESHOLD,
  clampLimit,
  esc,
  parseEventAt,
  type Category,
  type Importance,
} from "./shared";

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

  // Resolve sender display names (user name, or "agent" for agent messages)
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
          ? "agent"
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

const remember: ToolHandler = async (args, ctx) => {
  const content = typeof args?.content === "string" ? args.content.trim() : "";
  const category = args?.category as Category;
  const importance = (args?.importance as Importance) || "medium";
  const subjectName =
    typeof args?.subjectName === "string" ? args.subjectName.trim() : "";
  const eventAt = parseEventAt(args?.eventAt);
  // Provenance (M2): optional on the tool path — the agent is usually
  // saving a fact in direct response to a user statement, in which case
  // passing the user's verbatim quote + their message id makes the fact
  // traceable later. We trust the agent here (no substring validation)
  // because the tool runs through JWT-verified callback already; the
  // worst case is a sloppy quote that hurts only the citation experience.
  const evidenceQuote =
    typeof args?.evidenceQuote === "string"
      ? args.evidenceQuote.trim().slice(0, 120)
      : null;
  const sourceMessageId =
    typeof args?.sourceMessageId === "string"
      ? args.sourceMessageId.trim()
      : null;

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
      confirmedAt: null,
      eventAt: eventAt ?? undefined,
      lastReinforcedAt: new Date(),
      evidenceQuote: evidenceQuote || undefined,
      sourceMessageIds: sourceMessageId ? [sourceMessageId] : undefined,
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

  // M2.5: provenance is now REQUIRED on UPDATE. HaluMem (arxiv
  // 2511.03506) empirically shows the update path is the bigger
  // hallucination vector vs extraction. Without a citable source, an
  // agent can silently rewrite facts.
  const sourceMessageId =
    typeof args?.sourceMessageId === "string"
      ? args.sourceMessageId.trim()
      : "";
  if (!sourceMessageId) {
    return {
      error:
        "sourceMessageId required — pass the msgId of the user message that motivates this update (their current message is fine)",
    };
  }
  const evidenceQuote =
    typeof args?.evidenceQuote === "string"
      ? args.evidenceQuote.trim().slice(0, 120)
      : null;

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
  // silently edited through this path. We also refresh source_message_ids
  // and evidence_quote so the row carries its MOST RECENT justification
  // (full audit trail with before/after will live in memory_revisions in
  // M5).
  const [row] = await db
    .update(userMemories)
    .set({
      ...patch,
      source: "user_explicit",
      lastReinforcedAt: new Date(),
      updatedAt: new Date(),
      sourceMessageIds: [sourceMessageId],
      ...(evidenceQuote ? { evidenceQuote } : {}),
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

  // M2.5: forget is a destructive update — require a citable source so we
  // can audit "why did this fact disappear?" later. HaluMem found
  // deletions are a substantial slice of memory hallucinations.
  const sourceMessageId =
    typeof args?.sourceMessageId === "string"
      ? args.sourceMessageId.trim()
      : "";
  if (!sourceMessageId) {
    return {
      error:
        "sourceMessageId required — pass the msgId of the user message asking to forget this fact (their current message is fine)",
    };
  }
  const evidenceQuote =
    typeof args?.evidenceQuote === "string"
      ? args.evidenceQuote.trim().slice(0, 120)
      : null;

  const [row] = await db
    .update(userMemories)
    .set({
      deletedAt: new Date(),
      source: "user_explicit",
      updatedAt: new Date(),
      sourceMessageIds: [sourceMessageId],
      ...(evidenceQuote ? { evidenceQuote } : {}),
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

export const userMemoryToolHandlers: Record<string, ToolHandler> = {
  search_memories: searchMemories,
  search_messages: searchMessages,
  remember,
  update_memory: updateMemory,
  forget_memory: forgetMemory,
  confirm_memory: confirmMemory,
};

export const userMemoryToolDefs = [
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
        "Search completed messages in the current room by substring (whole room, not just the recent-message window in your context). CALL THIS FIRST whenever the user asks about past room conversation — '上次', '之前', '那天', '还记得', '你说过', '聊过', 'earlier', 'remember when', etc — BEFORE you write your reply. Even if you think you remember the content, search to verify; do not paraphrase from imagined recall. Each result includes an `id` — cite the most-relevant 1-2 in your reply via the markdown form '[查看原文](msg:<id>)' (the frontend renders these as clickable chips that scroll to the source). If the search returns nothing relevant, say so explicitly — never fall back to fabricated past quotes.",
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
          sourceMessageId: {
            type: "string",
            description:
              'Strongly recommended. The msgId of the message that justifies this fact (pulled from a "(msgId=...)" prefix in the recent-window conversation). Lets the platform cite the source later when the user asks "where did you learn that?".',
          },
          evidenceQuote: {
            type: "string",
            description:
              'Strongly recommended. A verbatim substring (≤120 chars) FROM the message identified by sourceMessageId — the user\'s own words that support this fact. Do NOT paraphrase or translate; copy the original wording. Example: if user wrote "我特别能吃辣", evidenceQuote = "我特别能吃辣".',
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
        "Correct an existing memory. Call this when the user explicitly corrects a fact the agent remembers. The memory becomes user-locked and will not be touched by background extraction. REQUIRES sourceMessageId — usually the user's current message that contains the correction.",
      parameters: {
        type: "object",
        required: ["memoryId", "sourceMessageId"],
        properties: {
          memoryId: { type: "string" },
          content: { type: "string" },
          category: { type: "string", enum: [...VALID_CATEGORIES] },
          importance: { type: "string", enum: [...VALID_IMPORTANCES] },
          sourceMessageId: {
            type: "string",
            description:
              "REQUIRED. The msgId of the user message that motivates this correction (typically their CURRENT message — pull it from the recent-window (msgId=...) prefix). The platform audits memory edits and refuses untraceable updates.",
          },
          evidenceQuote: {
            type: "string",
            description:
              "Strongly recommended. A verbatim substring (≤120 chars) from the message identified by sourceMessageId — the user's own correction wording.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "forget_memory",
      description:
        "Soft-delete a memory so it's no longer used and the background extractor cannot re-create it. Call this when the user explicitly asks to forget something. REQUIRES sourceMessageId — the user's current message that asks to forget.",
      parameters: {
        type: "object",
        required: ["memoryId", "sourceMessageId"],
        properties: {
          memoryId: { type: "string" },
          reason: {
            type: "string",
            description: "Optional reason for logging.",
          },
          sourceMessageId: {
            type: "string",
            description:
              "REQUIRED. The msgId of the user message asking to forget this fact (typically their CURRENT message — pull it from the recent-window (msgId=...) prefix).",
          },
          evidenceQuote: {
            type: "string",
            description:
              "Strongly recommended. A verbatim substring (≤120 chars) from the message — the user's own forget request wording.",
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
];
