import { db, messages, users, userMemories } from "@agent-platform/db";
import { eq, desc, and, isNull, isNotNull, sql } from "drizzle-orm";
import { llmCompleteJSON } from "../llm.js";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("memory-worker");

interface UserMemoryData {
  roomId: string;
  userId: string;
}

// Threshold at which an incoming CREATE is treated as a near-duplicate of an
// existing active memory. Phase A change: the action is now REINFORCE (bump
// strength + last_reinforced_at on the existing row) rather than silent skip,
// so repeat mentions actually strengthen memory over time.
const DUP_REINFORCE_THRESHOLD = 0.55;

const VALID_CATEGORIES = ["identity", "preference", "relationship", "event", "opinion", "context"];
const VALID_IMPORTANCES = ["high", "medium", "low"];

function buildExtractionPrompt(language: string, nowIso: string): string {
  return `You analyze user messages to extract memorable facts about the user.

LANGUAGE (HIGHEST PRIORITY — follow before any other rule):
The user's recent messages are predominantly in ${language}. EVERY fact you
output MUST be written in ${language}. Do NOT translate. Do NOT use English
unless the user is writing in English.
Examples (match the user's language):
  - Chinese user: "喜欢吃辣", "住在深圳", "弟弟叫志龙"
  - English user: "Likes spicy food", "Lives in Shenzhen", "Has a brother named Zhilong"

TIME (SECOND HIGHEST PRIORITY):
Current time is ${nowIso}. Each recent message below has a [YYYY-MM-DD HH:mm]
prefix showing when it was sent.
- NEVER store relative phrases like "今天" / "昨天" / "刚才" / "中午" / "上周" /
  "yesterday" / "just now" inside the fact content. Resolve them into an
  absolute date based on the message's own timestamp and the current time.
- For facts that describe a specific event in time (e.g. "今天没吃午饭" → "2026-04-19 没吃午饭"),
  ALSO emit an \`eventAt\` field on the CREATE action as an ISO8601 timestamp
  (date is fine, e.g. "2026-04-19"; add time if the user was specific about
  "中午" etc.). For timeless facts (identity, preferences, relationships)
  leave eventAt omitted.
- Short-term statements that are ONLY meaningful for a few hours (e.g.
  "我饿了", "现在有点累") must be SKIPPED — they are not worth cross-session
  memory. If the same behaviour recurs across many days, a higher-level fact
  ("经常不吃午饭") will emerge from reinforcement; you don't need to seed it.

RULES:
- Only extract facts that would be useful to remember across conversations
- DO NOT extract: greetings, test messages, emotional expressions, single-word responses, questions the user asked the AI, commands to the AI, transient states
- DO extract: personal info (name, age, location, language), preferences (food, music, hobbies), relationships (family, friends mentioned by name), significant events, opinions, ongoing situations
- Each fact must be a single clear statement in third person (e.g. "喜欢吃辣" / "Likes spicy food", NOT first person)
- If a new fact contradicts an existing memory, output an UPDATE action with the existing memory's id
- If a new fact is already captured by an existing memory, SKIP it. Be strict — if in doubt, SKIP rather than duplicate. The backend will still reinforce the existing memory on near-duplicate CREATEs, so skipping is safe.
- If a fact is genuinely new, output a CREATE action
- If an existing memory is clearly wrong based on new info, output a DELETE action

HARD CONSTRAINTS (violating these will be rejected):
- FORGOTTEN FACTS: The user has explicitly asked to forget some facts. They are listed under "Forgotten facts". NEVER re-create any fact that is semantically similar to a forgotten one, even if the conversation mentions it again. If unsure, skip.
- LOCKED MEMORIES: Memories marked [LOCKED] were set or confirmed by the user directly. You MUST NOT output UPDATE or DELETE actions for locked memory ids. You may output CREATE for genuinely new facts that do not conflict.
- PENDING MEMORIES: Memories marked [PENDING] were written by someone else about this user and are waiting for the user's confirmation. Treat them exactly like active memories for dedup purposes: if a new message would just restate a pending fact, SKIP (do not emit a duplicate CREATE). You MUST NOT output UPDATE or DELETE actions for pending memory ids either — the subject has to confirm or reject them through the UI.

OUTPUT FORMAT (strict JSON):
{
  "actions": [
    {"action": "create", "content": "...", "category": "identity|preference|relationship|event|opinion|context", "importance": "high|medium|low", "eventAt": "2026-04-19" },
    {"action": "update", "memoryId": "<uuid>", "content": "updated content", "category": "...", "importance": "..."},
    {"action": "delete", "memoryId": "<uuid>", "reason": "..."}
  ]
}
(eventAt is OPTIONAL and only appears on CREATE; omit it for timeless facts.)

If nothing worth remembering, return: {"actions": []}

CATEGORY GUIDE:
- identity: name, age, location, nationality, language, occupation, education
- preference: food, hobbies, interests, communication style preferences
- relationship: family members, friends, colleagues mentioned by name or role
- event: significant things that happened, decisions made, milestones — these almost always want eventAt
- opinion: views on topics, beliefs, values
- context: current projects, goals, ongoing situations

IMPORTANCE GUIDE:
- high: core identity (name, language), strong/repeated preferences, important relationships
- medium: mentioned preferences, events, moderate context
- low: one-time mentions, minor details, casual opinions. Time-stamped single-event facts default to low/medium — they'll gain strength naturally if they recur.`;
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

/** Format a Date as "YYYY-MM-DD HH:mm" in Asia/Shanghai — matches the extraction
 *  prompt rule that relative time phrases resolve against the user's wall clock. */
function formatWallClock(d: Date): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get(
    "minute"
  )}`;
}

/** Parse an LLM-supplied eventAt string (date or datetime) into a Date, or
 *  return null if it's missing/invalid. Accepts "2026-04-19", "2026-04-19T12:30",
 *  or full ISO. Bare date strings anchor to Asia/Shanghai noon so timezone drift
 *  doesn't push them onto the prior day in UTC storage. */
function parseEventAt(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // Date-only: anchor to Asia/Shanghai 12:00 → 04:00 UTC
    const d = new Date(`${s}T04:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
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

  // Reverse in place → chronological order. Each line is prefixed with the
  // message's wall-clock timestamp so the LLM can resolve relative phrases.
  const ordered = [...recentUserMessages].reverse();
  const messagesText = ordered
    .map((m) => `[${formatWallClock(m.createdAt)}] ${m.content}`)
    .join("\n");

  // Language detection works on content only — timestamps are ASCII and would
  // skew the CJK ratio.
  const contentOnly = ordered.map((m) => m.content).join("\n");
  const language = detectLanguage(contentOnly);

  const nowIso = formatWallClock(new Date());

  const userPrompt = `User: ${user.name}
Primary language: ${language}
Current time: ${nowIso} (Asia/Shanghai)

Existing memories about this user:
${categorized}

Forgotten facts (user asked to forget — DO NOT re-create these):
${tombstoneText}

Recent messages from this user (each prefixed with the time it was sent):
${messagesText}

Analyze and return JSON. Remember: write every fact in ${language}, and resolve every relative time phrase into an absolute date.`;

  let result: { actions?: unknown[] };
  try {
    result = await llmCompleteJSON(
      buildExtractionPrompt(language, nowIso),
      userPrompt
    );
  } catch (err) {
    log.error({ roomId, userId, err }, "memory.llm-parse-error");
    return;
  }

  if (!result.actions || !Array.isArray(result.actions) || result.actions.length === 0) {
    log.info({ roomId, userId, userName: user.name }, "memory.no-new-memories");
    return;
  }

  // Local snapshot of "existing rows" (id + content) for dup detection. Grows
  // as we accept CREATEs in this batch so the LLM can't duplicate within a
  // single response.
  const existingForDupCheck: { id: string | null; content: string }[] =
    activeMemories.map((m) => ({ id: m.id, content: m.content }));

  let created = 0,
    updated = 0,
    deleted = 0,
    rejected = 0,
    reinforced = 0;

  await db.transaction(async (tx) => {
    for (const action of result.actions!) {
      const a = action as Record<string, unknown>;
      try {
        if (a.action === "create" && typeof a.content === "string") {
          if (
            typeof a.category !== "string" ||
            typeof a.importance !== "string" ||
            !VALID_CATEGORIES.includes(a.category) ||
            !VALID_IMPORTANCES.includes(a.importance)
          )
            continue;
          const content = a.content;
          const category = a.category;
          const importance = a.importance;

          // Near-dup detection: on a hit, REINFORCE the existing row rather
          // than skip. This is the core Phase A signal — if a user keeps
          // mentioning the same fact across different sessions, its strength
          // grows and the read-path decay holds it high.
          let best: { id: string | null; content: string; sim: number } | null =
            null;
          for (const existing of existingForDupCheck) {
            const sim = textSimilarity(content, existing.content);
            if (!best || sim > best.sim) {
              best = { id: existing.id, content: existing.content, sim };
            }
          }
          if (best && best.sim >= DUP_REINFORCE_THRESHOLD) {
            // best.id is null only for CREATEs accepted earlier in this same
            // batch (local twin); those can't be reinforced because the row
            // was just inserted. Skip silently in that case.
            if (best.id) {
              // Safety: locked/pending rows must not be silently mutated.
              if (lockedIds.has(best.id) || pendingIds.has(best.id)) {
                log.info(
                  { userId, content, twin: best.content, similarity: best.sim },
                  "memory.skip-reinforce-protected"
                );
              } else {
                await tx
                  .update(userMemories)
                  .set({
                    strength: sql`${userMemories.strength} + 1`,
                    lastReinforcedAt: new Date(),
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(userMemories.id, best.id),
                      eq(userMemories.source, "extracted")
                    )
                  );
                log.info(
                  {
                    userId,
                    memoryId: best.id,
                    content,
                    twin: best.content,
                    similarity: best.sim,
                  },
                  "memory.reinforce"
                );
                reinforced++;
              }
            }
            continue;
          }

          const eventAt = parseEventAt(a.eventAt);
          await tx.insert(userMemories).values({
            userId,
            content,
            category: category as any,
            importance: importance as any,
            source: "extracted",
            sourceRoomId: roomId,
            eventAt: eventAt ?? undefined,
            lastReinforcedAt: new Date(),
          });
          existingForDupCheck.push({ id: null, content });
          created++;
        } else if (
          a.action === "update" &&
          typeof a.memoryId === "string" &&
          typeof a.content === "string"
        ) {
          const memoryId = a.memoryId;
          if (lockedIds.has(memoryId)) {
            log.warn({ roomId, userId, memoryId }, "memory.blocked-update-on-locked");
            rejected++;
            continue;
          }
          if (pendingIds.has(memoryId)) {
            log.warn({ roomId, userId, memoryId }, "memory.blocked-update-on-pending");
            rejected++;
            continue;
          }
          await tx
            .update(userMemories)
            .set({
              content: a.content,
              category:
                typeof a.category === "string" &&
                VALID_CATEGORIES.includes(a.category)
                  ? (a.category as any)
                  : undefined,
              importance:
                typeof a.importance === "string" &&
                VALID_IMPORTANCES.includes(a.importance)
                  ? (a.importance as any)
                  : undefined,
              lastReinforcedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(userMemories.id, memoryId),
                eq(userMemories.userId, userId),
                eq(userMemories.source, "extracted")
              )
            );
          updated++;
        } else if (a.action === "delete" && typeof a.memoryId === "string") {
          const memoryId = a.memoryId;
          if (lockedIds.has(memoryId)) {
            log.warn({ roomId, userId, memoryId }, "memory.blocked-delete-on-locked");
            rejected++;
            continue;
          }
          if (pendingIds.has(memoryId)) {
            log.warn({ roomId, userId, memoryId }, "memory.blocked-delete-on-pending");
            rejected++;
            continue;
          }
          // Soft delete so the fact becomes a tombstone for future runs
          await tx
            .update(userMemories)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(
              and(
                eq(userMemories.id, memoryId),
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
    {
      roomId,
      userId,
      userName: user.name,
      language,
      created,
      updated,
      deleted,
      rejected,
      reinforced,
    },
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
