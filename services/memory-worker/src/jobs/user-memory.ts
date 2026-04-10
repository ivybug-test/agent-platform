import { db, messages, users, userMemories } from "@agent-platform/db";
import { eq, desc, and } from "drizzle-orm";
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
- If a new fact contradicts an existing memory, output an UPDATE action with the existing memory's id
- If a new fact is already captured by an existing memory, SKIP it
- If a fact is genuinely new, output a CREATE action
- If an existing memory is clearly wrong based on new info, output a DELETE action

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

  // Get ALL existing memories for this user (not just 10)
  const existingMemories = await db
    .select()
    .from(userMemories)
    .where(eq(userMemories.userId, userId))
    .orderBy(userMemories.category, desc(userMemories.createdAt));

  // Format existing memories by category with IDs
  const categorized = formatMemoriesByCategory(existingMemories);

  const messagesText = recentUserMessages
    .reverse()
    .map((m) => m.content)
    .join("\n");

  const userPrompt = `User: ${user.name}

Existing memories about this user:
${categorized}

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

  let created = 0, updated = 0, deleted = 0;

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
            sourceRoomId: roomId,
          });
          created++;
        } else if (a.action === "update" && a.memoryId && a.content) {
          await tx
            .update(userMemories)
            .set({
              content: a.content,
              category: VALID_CATEGORIES.includes(a.category) ? (a.category as any) : undefined,
              importance: VALID_IMPORTANCES.includes(a.importance) ? (a.importance as any) : undefined,
              updatedAt: new Date(),
            })
            .where(and(eq(userMemories.id, a.memoryId), eq(userMemories.userId, userId)));
          updated++;
        } else if (a.action === "delete" && a.memoryId) {
          await tx
            .delete(userMemories)
            .where(and(eq(userMemories.id, a.memoryId), eq(userMemories.userId, userId)));
          deleted++;
        }
      } catch (err) {
        log.error({ roomId, userId, action: a, err }, "memory.action-failed");
      }
    }
  });

  log.info({ roomId, userId, userName: user.name, created, updated, deleted }, "memory.result");
}

function formatMemoriesByCategory(
  memories: { id: string; content: string; category: string }[]
): string {
  const groups = new Map<string, { id: string; content: string }[]>();
  for (const m of memories) {
    const list = groups.get(m.category) || [];
    list.push({ id: m.id, content: m.content });
    groups.set(m.category, list);
  }

  if (groups.size === 0) return "(no existing memories)";

  const sections: string[] = [];
  for (const cat of VALID_CATEGORIES) {
    const items = groups.get(cat);
    if (items && items.length > 0) {
      sections.push(
        `[${cat}]\n${items.map((m) => `- (id: ${m.id}) ${m.content}`).join("\n")}`
      );
    }
  }
  return sections.join("\n\n");
}
