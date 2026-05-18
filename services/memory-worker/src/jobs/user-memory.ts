import { db, messages, users, userMemories } from "@agent-platform/db";
import { eq, desc, and, isNull, isNotNull, sql } from "drizzle-orm";
import { llmCompleteJSON } from "../llm.js";
import { createLogger } from "@agent-platform/logger";
import { textSimilarity } from "../text-similarity.js";
import { buildExtractionPrompt } from "../prompts/extraction.js";
import { embedOne } from "../embeddings.js";
import {
  VALID_CATEGORIES,
  VALID_IMPORTANCES,
  messageBody,
  detectLanguage,
  formatWallClock,
  parseEventAt,
  formatMemoriesByCategory,
} from "../lib/format.js";

// Max length of an evidence quote. Anything longer almost certainly is a
// rewrite/paraphrase rather than a verbatim substring; we accept up to this
// to leave headroom for honest long quotes but trim before storage.
const MAX_EVIDENCE_QUOTE_LEN = 120;

/** Normalise a string for substring matching: lowercase, collapse all
 *  whitespace runs to a single space, trim ends. Tolerant of the small
 *  formatting drift LLMs introduce (extra spaces, line-break swaps) but
 *  still anchors to the actual message wording. */
function normaliseForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Validate that `quote` is a verbatim substring of `source` (after light
 *  normalisation). Returns true if the quote can be considered genuine,
 *  false if it looks fabricated. */
function quoteMatchesMessage(quote: string, source: string): boolean {
  if (!quote || !source) return false;
  const q = normaliseForMatch(quote);
  if (q.length < 2) return false; // single chars are meaningless
  const s = normaliseForMatch(source);
  return s.includes(q);
}

const log = createLogger("memory-worker");

interface UserMemoryData {
  roomId: string;
  userId: string;
}

// Bigram Jaccard threshold — kept for the literal near-duplicate case
// (same fact, different phrasing word-order). Phase A semantics:
// REINFORCE on hit instead of silent skip.
const DUP_REINFORCE_THRESHOLD = 0.55;

// M5c: cosine threshold — catches paraphrase that bigram misses
// ("喜欢甜食" ↔ "爱吃蛋糕", "讨厌堵车" ↔ "上下班路上很烦"). Conservative
// 0.82 chosen so genuinely distinct facts ("喜欢甜食" vs "喜欢咸食",
// typically ~0.65-0.75) don't get falsely merged. Logged on hit so we can
// observe and tune.
const COSINE_REINFORCE_THRESHOLD = 0.82;

/** Cosine similarity of two equal-length vectors. Assumes neither is the
 *  zero vector — text-embedding-3-small never returns one for non-empty
 *  text. Returns NaN-safe 0 if either input is malformed. */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
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

  // Reverse in place → chronological order. Each line carries the message's
  // wall-clock timestamp AND (msgId=...) so the extractor can cite the exact
  // source message in its provenance fields.
  const ordered = [...recentUserMessages].reverse();
  const messagesText = ordered
    .map(
      (m) =>
        `[${formatWallClock(m.createdAt)}] (msgId=${m.id}) ${messageBody(m)}`
    )
    .join("\n");

  // Map for fast provenance lookup after the LLM returns.
  const msgById = new Map(ordered.map((m) => [m.id, m]));

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

  // Local snapshot of "existing rows" for dup detection. Carries the
  // embedding so M5c can run cosine dedup alongside bigram. Grows as we
  // accept CREATEs in this batch so the LLM can't duplicate within a
  // single response. For locally-just-created rows, id is null (can't
  // reinforce a row that's still in the same transaction) but the
  // embedding can still block local twins.
  const existingForDupCheck: {
    id: string | null;
    content: string;
    embedding: number[] | null;
  }[] = activeMemories.map((m) => ({
    id: m.id,
    content: m.content,
    embedding: m.embedding ?? null,
  }));

  let created = 0,
    updated = 0,
    deleted = 0,
    rejected = 0,
    reinforced = 0,
    cosineReinforced = 0,
    evidenceMismatch = 0;

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

          // M2: provenance is mandatory on CREATE. Without a valid
          // sourceMessageId pointing at one of the recent messages AND an
          // evidenceQuote that substring-matches that message, drop the
          // action — this is what blocks the LLM from fabricating facts.
          const sourceMessageId =
            typeof a.sourceMessageId === "string" ? a.sourceMessageId : null;
          const evidenceQuote =
            typeof a.evidenceQuote === "string"
              ? a.evidenceQuote.slice(0, MAX_EVIDENCE_QUOTE_LEN)
              : null;
          if (!sourceMessageId || !evidenceQuote) {
            log.warn(
              { roomId, userId, content, sourceMessageId, evidenceQuote },
              "memory.extraction-missing-provenance"
            );
            evidenceMismatch++;
            continue;
          }
          const sourceMsg = msgById.get(sourceMessageId);
          if (!sourceMsg) {
            log.warn(
              { roomId, userId, content, sourceMessageId },
              "memory.extraction-bad-source-id"
            );
            evidenceMismatch++;
            continue;
          }
          const sourceText = messageBody(sourceMsg);
          if (!quoteMatchesMessage(evidenceQuote, sourceText)) {
            log.warn(
              {
                roomId,
                userId,
                content,
                sourceMessageId,
                quote: evidenceQuote,
                sourceSnippet: sourceText.slice(0, 80),
              },
              "memory.extraction-evidence-mismatch"
            );
            evidenceMismatch++;
            continue;
          }

          // M5c: pre-compute embedding so it can feed both cosine dedup AND
          // the eventual storage write. Single API call, dual purpose.
          // Failure non-fatal — falls back to bigram-only dedup, and
          // backfill catches the missing embedding later.
          let embedding: number[] | null = null;
          try {
            embedding = await embedOne(content);
          } catch (err) {
            log.warn(
              { userId, content, err: (err as Error).message },
              "memory.embedding-failed"
            );
          }

          // Near-dup detection: REINFORCE on hit (Phase A semantics).
          // Two signals in parallel — bigram (literal near-duplicate) and
          // cosine (semantic paraphrase, M5c). Pick whichever scores
          // higher relative to its threshold. Locked/pending rows are
          // never reinforced.
          let bestBigram: { id: string | null; content: string; sim: number } | null = null;
          let bestCosine: { id: string | null; content: string; sim: number } | null = null;
          for (const existing of existingForDupCheck) {
            const simB = textSimilarity(content, existing.content);
            if (!bestBigram || simB > bestBigram.sim) {
              bestBigram = { id: existing.id, content: existing.content, sim: simB };
            }
            if (embedding && existing.embedding) {
              const simC = cosineSimilarity(embedding, existing.embedding);
              if (!bestCosine || simC > bestCosine.sim) {
                bestCosine = { id: existing.id, content: existing.content, sim: simC };
              }
            }
          }

          const bigramHit =
            bestBigram && bestBigram.sim >= DUP_REINFORCE_THRESHOLD;
          const cosineHit =
            bestCosine && bestCosine.sim >= COSINE_REINFORCE_THRESHOLD;

          // Choose the trigger that scored highest above its threshold.
          // Bigram and cosine thresholds aren't directly comparable, so we
          // normalise by (sim - threshold) — whichever is more confident
          // wins. Tie-breaker: bigram (literal match is more trustworthy).
          let trigger: { id: string | null; content: string; sim: number } | null = null;
          let triggerType: "bigram" | "cosine" = "bigram";
          if (bigramHit && cosineHit) {
            const bigramMargin = bestBigram!.sim - DUP_REINFORCE_THRESHOLD;
            const cosineMargin = bestCosine!.sim - COSINE_REINFORCE_THRESHOLD;
            if (cosineMargin > bigramMargin) {
              trigger = bestCosine;
              triggerType = "cosine";
            } else {
              trigger = bestBigram;
              triggerType = "bigram";
            }
          } else if (bigramHit) {
            trigger = bestBigram;
            triggerType = "bigram";
          } else if (cosineHit) {
            trigger = bestCosine;
            triggerType = "cosine";
          }

          if (trigger) {
            // trigger.id null = local-batch twin (just CREATEd in this
            // same response); can't reinforce a row that doesn't exist
            // yet. Skip silently.
            if (trigger.id) {
              if (lockedIds.has(trigger.id) || pendingIds.has(trigger.id)) {
                log.info(
                  {
                    userId,
                    content,
                    twin: trigger.content,
                    similarity: trigger.sim,
                    triggerType,
                  },
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
                      eq(userMemories.id, trigger.id),
                      eq(userMemories.source, "extracted")
                    )
                  );
                log.info(
                  {
                    userId,
                    memoryId: trigger.id,
                    content,
                    twin: trigger.content,
                    similarity: trigger.sim,
                    triggerType,
                  },
                  "memory.reinforce"
                );
                reinforced++;
                if (triggerType === "cosine") cosineReinforced++;
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
            sourceMessageIds: [sourceMessageId],
            evidenceQuote,
            embedding: embedding ?? undefined,
          });
          existingForDupCheck.push({ id: null, content, embedding });
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
      cosineReinforced,
      evidenceMismatch,
    },
    "memory.result"
  );
}

