import { db, userMemories, messages, users } from "@agent-platform/db";
import { and, eq, isNull, desc, ilike, or, lt, inArray } from "drizzle-orm";
import type { ToolHandler } from "./index";

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

// -----------------------------------------------------------------------------
// search_memories
// -----------------------------------------------------------------------------

const searchMemories: ToolHandler = async (args, ctx) => {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  const category = VALID_CATEGORIES.includes(args?.category)
    ? (args.category as Category)
    : null;
  const limit = clampLimit(args?.limit, 10, 30);

  const conditions = [
    eq(userMemories.userId, ctx.userId),
    isNull(userMemories.deletedAt),
  ];
  if (category) conditions.push(eq(userMemories.category, category));
  if (query) conditions.push(ilike(userMemories.content, `%${esc(query)}%`));

  const rows = await db
    .select({
      id: userMemories.id,
      content: userMemories.content,
      category: userMemories.category,
      importance: userMemories.importance,
      source: userMemories.source,
      updatedAt: userMemories.updatedAt,
    })
    .from(userMemories)
    .where(and(...conditions))
    .orderBy(desc(userMemories.importance), desc(userMemories.updatedAt))
    .limit(limit);

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
  const before =
    typeof args?.before === "string" && args.before
      ? new Date(args.before)
      : null;

  const conditions = [
    eq(messages.roomId, ctx.roomId),
    eq(messages.status, "completed"),
    ilike(messages.content, `%${esc(query)}%`),
  ];
  if (before && !isNaN(before.getTime())) {
    conditions.push(lt(messages.createdAt, before));
  }

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
    .orderBy(desc(messages.createdAt))
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

const SIMILARITY_SKIP_THRESHOLD = 0.55;

const remember: ToolHandler = async (args, ctx) => {
  const content = typeof args?.content === "string" ? args.content.trim() : "";
  const category = args?.category as Category;
  const importance = (args?.importance as Importance) || "medium";

  if (!content) return { error: "content required" };
  if (!VALID_CATEGORIES.includes(category)) {
    return { error: "invalid category" };
  }
  if (!VALID_IMPORTANCES.includes(importance)) {
    return { error: "invalid importance" };
  }

  // Scan existing active memories for near duplicates
  const existing = await db
    .select({
      id: userMemories.id,
      content: userMemories.content,
      source: userMemories.source,
    })
    .from(userMemories)
    .where(
      and(
        eq(userMemories.userId, ctx.userId),
        isNull(userMemories.deletedAt)
      )
    );

  let best: { id: string; content: string; sim: number; source: string } | null =
    null;
  for (const m of existing) {
    const sim = textSimilarity(content, m.content);
    if (!best || sim > best.sim) {
      best = { id: m.id, content: m.content, sim, source: m.source };
    }
  }

  if (best && best.sim >= SIMILARITY_SKIP_THRESHOLD) {
    return {
      skipped: true,
      reason: "near-duplicate of an existing memory",
      similar: { id: best.id, content: best.content, similarity: best.sim },
    };
  }

  const [row] = await db
    .insert(userMemories)
    .values({
      userId: ctx.userId,
      content,
      category,
      importance,
      source: "extracted",
      sourceRoomId: ctx.roomId,
    })
    .returning({
      id: userMemories.id,
      content: userMemories.content,
      category: userMemories.category,
      importance: userMemories.importance,
    });

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
        isNull(userMemories.deletedAt)
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
        isNull(userMemories.deletedAt)
      )
    )
    .returning({ id: userMemories.id });

  if (!row) return { error: "memory not found" };
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
};

// OpenAI-shaped tool definitions — passed to agent-runtime in the /chat body.
export const memoryToolDefs = [
  {
    type: "function" as const,
    function: {
      name: "search_memories",
      description:
        "Search the current user's stored long-term memories (facts, preferences, relationships, etc.). Use when you suspect there's a relevant fact you weren't told in the current system prompt.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Substring to match against memory content (case-insensitive). Leave empty to list by category.",
          },
          category: {
            type: "string",
            enum: [...VALID_CATEGORIES],
            description: "Restrict to one category.",
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
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "remember",
      description:
        "Store a new long-term fact about the current user. The tool checks for near-duplicates and will skip creation if a similar memory already exists. Use only for facts worth remembering across sessions (identity, preference, relationship, event, opinion, context).",
      parameters: {
        type: "object",
        required: ["content", "category", "importance"],
        properties: {
          content: {
            type: "string",
            description:
              'Third-person single-sentence fact, written in the SAME LANGUAGE the user is speaking (Chinese input → Chinese fact, English input → English fact, do not translate). Example: "住在深圳" / "Lives in Shenzhen".',
          },
          category: {
            type: "string",
            enum: [...VALID_CATEGORIES],
          },
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
];
