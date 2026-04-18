import { db, messages, users, userMemories } from "@agent-platform/db";
import { eq, desc, and, isNull, isNotNull } from "drizzle-orm";
import { llmCompleteJSON } from "../llm.js";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("memory-worker");

interface UserMemoryData {
  roomId: string;
  userId: string;
}

// Threshold above which an incoming CREATE is rejected as a near-duplicate of
// an existing active memory for the same user. Same algorithm the `remember`
// tool uses, same default.
const DUP_SKIP_THRESHOLD = 0.55;

const VALID_CATEGORIES = ["identity", "preference", "relationship", "event", "opinion", "context"];
const VALID_IMPORTANCES = ["high", "medium", "low"];

function buildExtractionPrompt(language: string): string {
  return `You analyze user messages to extract memorable facts about the user.

LANGUAGE (HIGHEST PRIORITY — follow before any other rule):
The user's recent messages are predominantly in ${language}. EVERY fact you
output MUST be written in ${language}. Do NOT translate. Do NOT use English
unless the user is writing in English.
Examples (match the user's language):
  - Chinese user: "喜欢吃辣", "住在深圳", "弟弟叫志龙"
  - English user: "Likes spicy food", "Lives in Shenzhen", "Has a brother named Zhilong"

RULES:
- Only extract facts that would be useful to remember across conversations
- DO NOT extract: greetings, test messages, emotional expressions, single-word responses, questions the user asked the AI, commands to the AI
- DO extract: personal info (name, age, location, language), preferences (food, music, hobbies), relationships (family, friends mentioned by name), significant events, opinions, ongoing situations
- Each fact must be a single clear statement in third person (e.g. "喜欢吃辣" / "Likes spicy food", NOT first person)
- If a new fact contradicts an existing memory, output an UPDATE action with the existing memory's id
- If a new fact is already captured by an existing memory, SKIP it. Be strict — if in doubt, SKIP rather than duplicate.
- If a fact is genuinely new, output a CREATE action
- If an existing memory is clearly wrong based on new info, output a DELETE action

HARD CONSTRAINTS (violating these will be rejected):
- FORGOTTEN FACTS: The user has explicitly asked to forget some facts. They are listed under "Forgotten facts". NEVER re-create any fact that is semantically similar to a forgotten one, even if the conversation mentions it again. If unsure, skip.
- LOCKED MEMORIES: Memories marked [LOCKED] were set or confirmed by the user directly. You MUST NOT output UPDATE or DELETE actions for locked memory ids. You may output CREATE for genuinely new facts that do not conflict.
- PENDING MEMORIES: Memories marked [PENDING] were written by someone else about this user and are waiting for the user's confirmation. Treat them exactly like active memories for dedup purposes: if a new message would just restate a pending fact, SKIP (do not emit a duplicate CREATE). You MUST NOT output UPDATE or DELETE actions for pending memory ids either — the subject has to confirm or reject them through the UI.

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
}

/** Character-bigram Jaccard similarity (CJK-safe). */
function textSimilarity(a: string, b: string): number {
  const bigrams = (s: string) => {
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
  const keys = new Set([...bgA.keys(), ...bgB.keys()]);
  for (const k of keys) {
    const ca = bgA.get(k) || 0;
    const cb = bgB.get(k) || 0;
    intersection += Math.min(ca, cb);
    union += Math.max(ca, cb);
  }
  return union === 0 ? 0 : intersection / union;
}

/** Detect language of text: if >30% characters are CJK, call it Chinese. */
function detectLanguage(text: string): string {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const total = text.replace(/\s/g, "").length;
  return total > 0 && cjk / total > 0.3 ? "Chinese" : "English";
}

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

  // Get ALL active memories (tombstones loaded separately below). This
  // includes both confirmed rows (what the agent sees today) AND pending
  // third-party rows — we DON'T want the extractor to output a CREATE that
  // would just duplicate a pending fact still awaiting confirmation.
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
  const pendingIds = new Set(
    activeMemories
      .filter(
        (m) =>
          m.authoredByUserId !== null &&
          m.authoredByUserId !== m.userId &&
          m.confirmedAt === null
      )
      .map((m) => m.id)
  );

  const categorized = formatMemoriesByCategory(
    activeMemories,
    lockedIds,
    pendingIds
  );
  const tombstoneText =
    tombstones.length > 0
      ? tombstones.map((t) => `- ${t.content}`).join("\n")
      : "(none)";

  const messagesText = recentUserMessages
    .reverse()
    .map((m) => m.content)
    .join("\n");

  const language = detectLanguage(messagesText);

  const userPrompt = `User: ${user.name}
Primary language: ${language}

Existing memories about this user:
${categorized}

Forgotten facts (user asked to forget — DO NOT re-create these):
${tombstoneText}

Recent messages from this user:
${messagesText}

Analyze and return JSON. Remember: write every fact in ${language}.`;

  let result: { actions?: unknown[] };
  try {
    result = await llmCompleteJSON(buildExtractionPrompt(language), userPrompt);
  } catch (err) {
    log.error({ roomId, userId, err }, "memory.llm-parse-error");
    return;
  }

  if (!result.actions || !Array.isArray(result.actions) || result.actions.length === 0) {
    log.info({ roomId, userId, userName: user.name }, "memory.no-new-memories");
    return;
  }

  // Local snapshot of "existing content" that grows as we accept CREATEs in
  // this batch — prevents the LLM from emitting the same CREATE twice in one
  // response.
  const existingForDupCheck: string[] = activeMemories.map((m) => m.content);

  let created = 0, updated = 0, deleted = 0, rejected = 0, dupSkipped = 0;

  await db.transaction(async (tx) => {
    for (const action of result.actions!) {
      const a = action as Record<string, string>;
      try {
        if (a.action === "create" && a.content) {
          if (!VALID_CATEGORIES.includes(a.category) || !VALID_IMPORTANCES.includes(a.importance)) continue;

          // Hard guard against near-duplicates the LLM slipped through.
          let maxSim = 0;
          let twin = "";
          for (const existing of existingForDupCheck) {
            const sim = textSimilarity(a.content, existing);
            if (sim > maxSim) {
              maxSim = sim;
              twin = existing;
            }
          }
          if (maxSim >= DUP_SKIP_THRESHOLD) {
            log.info(
              { userId, content: a.content, twin, similarity: maxSim },
              "memory.skip-near-dup"
            );
            dupSkipped++;
            continue;
          }

          await tx.insert(userMemories).values({
            userId,
            content: a.content,
            category: a.category as any,
            importance: a.importance as any,
            source: "extracted",
            sourceRoomId: roomId,
          });
          existingForDupCheck.push(a.content);
          created++;
        } else if (a.action === "update" && a.memoryId && a.content) {
          if (lockedIds.has(a.memoryId)) {
            log.warn({ roomId, userId, memoryId: a.memoryId }, "memory.blocked-update-on-locked");
            rejected++;
            continue;
          }
          if (pendingIds.has(a.memoryId)) {
            log.warn({ roomId, userId, memoryId: a.memoryId }, "memory.blocked-update-on-pending");
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
          if (pendingIds.has(a.memoryId)) {
            log.warn({ roomId, userId, memoryId: a.memoryId }, "memory.blocked-delete-on-pending");
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

  log.info(
    { roomId, userId, userName: user.name, language, created, updated, deleted, rejected, dupSkipped },
    "memory.result"
  );
}

function formatMemoriesByCategory(
  memories: { id: string; content: string; category: string }[],
  lockedIds: Set<string>,
  pendingIds: Set<string>
): string {
  const groups = new Map<
    string,
    { id: string; content: string; locked: boolean; pending: boolean }[]
  >();
  for (const m of memories) {
    const list = groups.get(m.category) || [];
    list.push({
      id: m.id,
      content: m.content,
      locked: lockedIds.has(m.id),
      pending: pendingIds.has(m.id),
    });
    groups.set(m.category, list);
  }

  if (groups.size === 0) return "(no existing memories)";

  const sections: string[] = [];
  for (const cat of VALID_CATEGORIES) {
    const items = groups.get(cat);
    if (items && items.length > 0) {
      sections.push(
        `[${cat}]\n${items
          .map((m) => {
            const tags = [
              m.locked ? "[LOCKED]" : "",
              m.pending ? "[PENDING]" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return `- ${tags ? tags + " " : ""}(id: ${m.id}) ${m.content}`;
          })
          .join("\n")}`
      );
    }
  }
  return sections.join("\n\n");
}
