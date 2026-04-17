import { db, messages, users, userMemories } from "@agent-platform/db";
import { eq, desc, and, isNull, isNotNull } from "drizzle-orm";
import { llmCompleteJSON } from "../llm.js";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("memory-worker");

interface UserMemoryData {
  roomId: string;
  userId: string;
}

const EXTRACTION_SYSTEM_PROMPT = `You analyze user messages to extract memorable facts about the user.

RULES:
- Only extract facts that would be useful to remember across conversations
- DO NOT extract: greetings, test messages, emotional expressions, single-word responses, questions the user asked the AI, commands to the AI
- DO extract: personal info (name, age, location, language), preferences (food, music, hobbies), relationships (family, friends mentioned by name), significant events, opinions, ongoing situations
- Each fact must be a single clear statement in third person (e.g. "Likes spicy food" not "I like spicy food")
- LANGUAGE: Write each fact in the same language the user predominantly uses in the recent messages. If the user writes in Chinese, write the fact in Chinese (e.g. "喜欢吃辣"). If in English, write in English. Mirror the user's language — do NOT translate.
- If a new fact contradicts an existing memory, output an UPDATE action with the existing memory's id
- If a new fact is already captured by an existing memory, SKIP it
- If a fact is genuinely new, output a CREATE action
- If an existing memory is clearly wrong based on new info, output a DELETE action

HARD CONSTRAINTS (violating these will be rejected):
- FORGOTTEN FACTS: The user has explicitly asked to forget some facts. They are listed under "Forgotten facts". NEVER re-create any fact that is semantically similar to a forgotten one, even if the conversation mentions it again. If unsure, skip.
- LOCKED MEMORIES: Memories marked [LOCKED] were set or confirmed by the user directly. You MUST NOT output UPDATE or DELETE actions for locked memory ids. You may output CREATE for genuinely new facts that do not conflict.

OUTPUT FORMAT (strict JSON):
{
  "actions": [
    {"action": "create", "content": "...", "category": "identity|preference|relationship|event|opinion|context", "importance": "high|medium|low"},
    {"action": "update", "memoryId": "<uuid>", "content": "updated content", "category": "...", "importance": "..."},
    {"action": "delete", "memoryId": "<uuid>", "reason": "..."}
  ]
}

If nothing worth remembering, return: {"actions": []}

CATEGORY GUIDE:
- identity: name, age, location, nationality, language, occupation, education
- preference: food, hobbies, interests, communication style preferences
- relationship: family members, friends, colleagues mentioned by name or role
- event: significant things that happened, decisions made, milestones
- opinion: views on topics, beliefs, values
- context: current projects, goals, ongoing situations

IMPORTANCE GUIDE:
- high: core identity (name, language), strong/repeated preferences, important relationships
- medium: mentioned preferences, events, moderate context
- low: one-time mentions, minor details, casual opinions`;

const VALID_CATEGORIES = ["identity", "preference", "relationship", "event", "opinion", "context"];
const VALID_IMPORTANCES = ["high", "medium", "low"];

export async function processUserMemory(data: UserMemoryData) {
  const { roomId, userId } = data;

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return;

  // Get recent messages from this user in this room
  const recentUserMessages = await db
    .select()
    .from(messages)
    .where(and(eq(messages.roomId, roomId), eq(messages.senderId, userId)))
    .orderBy(desc(messages.createdAt))
    .limit(20);

  if (recentUserMessages.length < 3) {
    log.info({ roomId, userId, userName: user.name }, "memory.skip-user-few-messages");
    return;
  }

  // Get ALL active memories (tombstones loaded separately below)
  const activeMemories = await db
    .select()
    .from(userMemories)
    .where(and(eq(userMemories.userId, userId), isNull(userMemories.deletedAt)))
    .orderBy(userMemories.category, desc(userMemories.createdAt));

  // Get soft-deleted (tombstoned) memories — the LLM must not re-create these
  const tombstones = await db
    .select({ content: userMemories.content })
    .from(userMemories)
    .where(and(eq(userMemories.userId, userId), isNotNull(userMemories.deletedAt)));

  const lockedIds = new Set(
    activeMemories.filter((m) => m.source === "user_explicit").map((m) => m.id)
  );

  const categorized = formatMemoriesByCategory(activeMemories, lockedIds);
  const tombstoneText =
    tombstones.length > 0
      ? tombstones.map((t) => `- ${t.content}`).join("\n")
      : "(none)";

  const messagesText = recentUserMessages
    .reverse()
    .map((m) => m.content)
    .join("\n");

  const userPrompt = `User: ${user.name}

Existing memories about this user:
${categorized}

Forgotten facts (user asked to forget — DO NOT re-create these):
${tombstoneText}

Recent messages from this user:
${messagesText}

Analyze and return JSON:`;

  let result: { actions?: unknown[] };
  try {
    result = await llmCompleteJSON(EXTRACTION_SYSTEM_PROMPT, userPrompt);
  } catch (err) {
    log.error({ roomId, userId, err }, "memory.llm-parse-error");
    return;
  }

  if (!result.actions || !Array.isArray(result.actions) || result.actions.length === 0) {
    log.info({ roomId, userId, userName: user.name }, "memory.no-new-memories");
    return;
  }

  let created = 0, updated = 0, deleted = 0, rejected = 0;

  await db.transaction(async (tx) => {
    for (const action of result.actions!) {
      const a = action as Record<string, string>;
      try {
        if (a.action === "create" && a.content) {
          if (!VALID_CATEGORIES.includes(a.category) || !VALID_IMPORTANCES.includes(a.importance)) continue;
          await tx.insert(userMemories).values({
            userId,
            content: a.content,
            category: a.category as any,
            importance: a.importance as any,
            source: "extracted",
            sourceRoomId: roomId,
          });
          created++;
        } else if (a.action === "update" && a.memoryId && a.content) {
          if (lockedIds.has(a.memoryId)) {
            log.warn({ roomId, userId, memoryId: a.memoryId }, "memory.blocked-update-on-locked");
            rejected++;
            continue;
          }
          await tx
            .update(userMemories)
            .set({
              content: a.content,
              category: VALID_CATEGORIES.includes(a.category) ? (a.category as any) : undefined,
              importance: VALID_IMPORTANCES.includes(a.importance) ? (a.importance as any) : undefined,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(userMemories.id, a.memoryId),
                eq(userMemories.userId, userId),
                eq(userMemories.source, "extracted")
              )
            );
          updated++;
        } else if (a.action === "delete" && a.memoryId) {
          if (lockedIds.has(a.memoryId)) {
            log.warn({ roomId, userId, memoryId: a.memoryId }, "memory.blocked-delete-on-locked");
            rejected++;
            continue;
          }
          // Soft delete so the fact becomes a tombstone for future runs
          await tx
            .update(userMemories)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(
              and(
                eq(userMemories.id, a.memoryId),
                eq(userMemories.userId, userId),
                eq(userMemories.source, "extracted")
              )
            );
          deleted++;
        }
      } catch (err) {
        log.error({ roomId, userId, action: a, err }, "memory.action-failed");
      }
    }
  });

  log.info({ roomId, userId, userName: user.name, created, updated, deleted, rejected }, "memory.result");
}

function formatMemoriesByCategory(
  memories: { id: string; content: string; category: string }[],
  lockedIds: Set<string>
): string {
  const groups = new Map<string, { id: string; content: string; locked: boolean }[]>();
  for (const m of memories) {
    const list = groups.get(m.category) || [];
    list.push({ id: m.id, content: m.content, locked: lockedIds.has(m.id) });
    groups.set(m.category, list);
  }

  if (groups.size === 0) return "(no existing memories)";

  const sections: string[] = [];
  for (const cat of VALID_CATEGORIES) {
    const items = groups.get(cat);
    if (items && items.length > 0) {
      sections.push(
        `[${cat}]\n${items
          .map(
            (m) =>
              `- ${m.locked ? "[LOCKED] " : ""}(id: ${m.id}) ${m.content}`
          )
          .join("\n")}`
      );
    }
  }
  return sections.join("\n\n");
}
