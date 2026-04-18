import { db, userMemories, messages } from "@agent-platform/db";
import { and, eq, isNull, desc } from "drizzle-orm";
import { llmCompleteJSON } from "../llm.js";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("memory-worker");

const BATCH_SIZE = 20;
const RECENT_MESSAGE_SAMPLE = 20;

interface MemoryTranslateData {
  userId: string;
  /**
   * Force the translation target language. When omitted the job auto-detects
   * from the user's recent messages (>30% CJK = Chinese). Pass "Chinese"
   * explicitly from the bulk cleanup CLI so admin-style users whose typed
   * messages are mostly English still get their extracted memories
   * translated.
   */
  forceLanguage?: "Chinese";
}

export interface TranslateResult {
  userLang: string;
  activeCount: number;
  targetCount: number;
  translated: number;
  failed: number;
}

/** Character-ratio language detection, matches extractor heuristic. */
function detectLanguage(text: string): "Chinese" | "English" {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const total = text.replace(/\s/g, "").length;
  return total > 0 && cjk / total > 0.3 ? "Chinese" : "English";
}

const TRANSLATE_SYSTEM_PROMPT = `You translate short third-person fact statements about a user.

Target language: Chinese.

You receive a numbered list of facts in English. For EACH fact, output a concise Chinese rendering (one sentence, third-person, no "The user" prefix). Keep the meaning identical — do not add or drop information.

OUTPUT (strict JSON only):
{"translations": ["翻译1", "翻译2", ...]}

The translations array MUST have exactly the same length as the input list and be in the same order.`;

/**
 * Batch-translate an active user's extracted English memories into the user's
 * predominant language (currently only Chinese targeted). Soft-locked rows
 * (source='user_explicit') are left alone. Idempotent — already-Chinese rows
 * are filtered out before the LLM call.
 */
export async function processMemoryTranslate(
  data: MemoryTranslateData
): Promise<TranslateResult> {
  const { userId, forceLanguage } = data;

  let userLang: "Chinese" | "English" | "forced-Chinese" = "English";
  if (forceLanguage === "Chinese") {
    userLang = "forced-Chinese";
  } else {
    const recentMsgs = await db
      .select({ content: messages.content })
      .from(messages)
      .where(
        and(eq(messages.senderId, userId), eq(messages.senderType, "user"))
      )
      .orderBy(desc(messages.createdAt))
      .limit(RECENT_MESSAGE_SAMPLE);

    if (recentMsgs.length === 0) {
      log.info({ userId }, "memory-translate.no-recent-messages");
      return { userLang: "unknown", activeCount: 0, targetCount: 0, translated: 0, failed: 0 };
    }

    const detected = detectLanguage(
      recentMsgs.map((m) => m.content).join("\n")
    );
    if (detected !== "Chinese") {
      // Auto-detect said English; skip unless caller forced Chinese.
      log.info({ userId, userLang: detected }, "memory-translate.skip-non-chinese-user");
      return { userLang: detected, activeCount: 0, targetCount: 0, translated: 0, failed: 0 };
    }
    userLang = detected;
  }

  const active = await db
    .select({
      id: userMemories.id,
      content: userMemories.content,
      source: userMemories.source,
    })
    .from(userMemories)
    .where(
      and(eq(userMemories.userId, userId), isNull(userMemories.deletedAt))
    );

  const targets = active.filter(
    (m) => m.source === "extracted" && detectLanguage(m.content) === "English"
  );

  if (targets.length === 0) {
    log.info({ userId, activeCount: active.length }, "memory-translate.none");
    return { userLang, activeCount: active.length, targetCount: 0, translated: 0, failed: 0 };
  }

  let translated = 0;
  let failed = 0;

  const totalBatches = Math.ceil(targets.length / BATCH_SIZE);
  console.log(
    `    translate: ${targets.length} English memories in ${totalBatches} batch(es)`
  );

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    const batchNo = Math.floor(i / BATCH_SIZE) + 1;
    const prompt = batch.map((m, idx) => `${idx + 1}. ${m.content}`).join("\n");
    const startedAt = Date.now();
    process.stdout.write(
      `    translate batch ${batchNo}/${totalBatches}... `
    );

    try {
      const result = await llmCompleteJSON<{ translations?: unknown[] }>(
        TRANSLATE_SYSTEM_PROMPT,
        prompt
      );
      console.log(`${Date.now() - startedAt}ms`);
      const outputs = Array.isArray(result.translations)
        ? result.translations
        : [];
      if (outputs.length !== batch.length) {
        log.warn(
          { userId, expected: batch.length, got: outputs.length },
          "memory-translate.length-mismatch"
        );
        failed += batch.length;
        continue;
      }

      await db.transaction(async (tx) => {
        for (let j = 0; j < batch.length; j++) {
          const nextContent = String(outputs[j] || "").trim();
          if (!nextContent || nextContent === batch[j].content) continue;
          // Only accept if the output looks like Chinese — avoid LLM leaving
          // text in English.
          if (detectLanguage(nextContent) !== "Chinese") continue;

          const updated = await tx
            .update(userMemories)
            .set({
              content: nextContent,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(userMemories.id, batch[j].id),
                eq(userMemories.userId, userId),
                eq(userMemories.source, "extracted"),
                isNull(userMemories.deletedAt)
              )
            )
            .returning({ id: userMemories.id });
          if (updated.length > 0) translated++;
        }
      });
    } catch (err: any) {
      console.log(
        `FAILED (${Date.now() - startedAt}ms): ${err?.message || "unknown"}`
      );
      log.error({ userId, err }, "memory-translate.batch-failed");
      failed += batch.length;
    }
  }

  log.info(
    { userId, totalTargets: targets.length, translated, failed },
    "memory-translate.result"
  );

  return {
    userLang,
    activeCount: active.length,
    targetCount: targets.length,
    translated,
    failed,
  };
}
