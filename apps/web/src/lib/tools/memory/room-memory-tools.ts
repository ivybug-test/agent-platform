import { db, roomMemories } from "@agent-platform/db";
import { and, eq, isNull, desc, ilike } from "drizzle-orm";
import type { ToolHandler } from "../index";
import { textSimilarity } from "@/lib/text-similarity";
import {
  VALID_IMPORTANCES,
  SIMILARITY_SKIP_THRESHOLD,
  clampLimit,
  esc,
  type Importance,
} from "./shared";

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

export const roomMemoryToolHandlers: Record<string, ToolHandler> = {
  search_room_memory: searchRoomMemory,
  save_room_fact: saveRoomFact,
  forget_room_fact: forgetRoomFact,
};

export const roomMemoryToolDefs = [
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
];
