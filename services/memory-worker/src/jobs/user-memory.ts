import { db, messages, users, userMemories } from "@agent-platform/db";
import { eq, desc, and, isNull, isNotNull, sql } from "drizzle-orm";
import { llmCompleteJSON } from "../llm.js";
import { createLogger } from "@agent-platform/logger";
import { textSimilarity } from "../text-similarity.js";
import { buildExtractionPrompt } from "../prompts/extraction.js";
import {
  VALID_CATEGORIES,
  VALID_IMPORTANCES,
  messageBody,
  detectLanguage,
  formatWallClock,
  parseEventAt,
  formatMemoriesByCategory,
} from "../lib/format.js";

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
    .map((m) => `[${formatWallClock(m.createdAt)}] ${messageBody(m)}`)
    .join("\n");

  // Language detection works on content only — timestamps are ASCII and would
  // skew the CJK ratio.
  const contentOnly = ordered.map((m) => messageBody(m)).join("\n");
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

