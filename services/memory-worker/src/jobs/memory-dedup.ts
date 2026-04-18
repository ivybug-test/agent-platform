import { db, userMemories } from "@agent-platform/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { llmCompleteJSON } from "../llm.js";
import { createLogger } from "@agent-platform/logger";
import type { Queue } from "bullmq";

const log = createLogger("memory-worker");

const CANDIDATE_THRESHOLD = 0.35; // pair survives to LLM if bigram-Jaccard ≥ this
const MAX_PAIRS_PER_USER = 10; // hard cap per LLM round — small so each call returns in <30s even on DeepSeek

interface MemoryDedupData {
  userId: string;
}

export interface DedupResult {
  totalRows: number;
  candidatePairs: number;
  askedLLM: number;
  merged: number;
  autoDeleted: number;
  rejected: number;
}

interface MemoryRow {
  id: string;
  content: string;
  source: string;
  category: string;
  importance: string;
  createdAt: Date;
}

const DEDUP_SYSTEM_PROMPT = `You are a memory deduplication assistant. You receive candidate duplicate pairs of long-term memories about a single user.

For each pair, decide if A and B cover the SAME FACT (same underlying information, regardless of wording).

RULES:
- If they cover the same fact, output {"action":"merge", "keepId": "<id>", "deleteId": "<id>", "mergedContent": "..."}.
  - mergedContent must be one concise third-person sentence that includes any extra detail from either side.
  - keepId is the row you want to survive; deleteId is the row to soft-delete. The keepId row's content will be replaced with mergedContent.
  - If one side is strictly more specific, pick it as keepId.
- If they describe related but distinct facts (e.g. different preferences of the same kind), output {"action":"keep_both"}.
- When in doubt, output {"action":"keep_both"}.
- Do NOT invent information not present in either memory.

OUTPUT (strict JSON only):
{"decisions":[{"pairIndex": 0, "action": "merge"|"keep_both", "keepId"?: "...", "deleteId"?: "...", "mergedContent"?: "..."}, ...]}`;

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

export async function processMemoryDedup(
  data: MemoryDedupData
): Promise<DedupResult> {
  const { userId } = data;

  const rows: MemoryRow[] = await db
    .select({
      id: userMemories.id,
      content: userMemories.content,
      source: userMemories.source,
      category: userMemories.category,
      importance: userMemories.importance,
      createdAt: userMemories.createdAt,
    })
    .from(userMemories)
    .where(
      and(eq(userMemories.userId, userId), isNull(userMemories.deletedAt))
    );

  if (rows.length < 2) {
    log.info({ userId, rowCount: rows.length }, "memory-dedup.skip-sparse");
    return {
      totalRows: rows.length,
      candidatePairs: 0,
      askedLLM: 0,
      merged: 0,
      autoDeleted: 0,
      rejected: 0,
    };
  }

  // Find candidate pairs
  const candidates: { a: MemoryRow; b: MemoryRow; sim: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const sim = textSimilarity(rows[i].content, rows[j].content);
      if (sim >= CANDIDATE_THRESHOLD) {
        candidates.push({ a: rows[i], b: rows[j], sim });
      }
    }
  }

  if (candidates.length === 0) {
    log.info({ userId, totalRows: rows.length }, "memory-dedup.no-candidates");
    return {
      totalRows: rows.length,
      candidatePairs: 0,
      askedLLM: 0,
      merged: 0,
      autoDeleted: 0,
      rejected: 0,
    };
  }

  candidates.sort((x, y) => y.sim - x.sim);
  const capped = candidates.slice(0, MAX_PAIRS_PER_USER);

  // Short-circuit cases that don't need the LLM
  //   both locked → hands off
  //   one locked + one extracted → user's version wins, soft-delete the extracted one
  //   both extracted → LLM judges
  const autoDelete: { id: string; twinContent: string }[] = [];
  const toAsk: { pairIndex: number; a: MemoryRow; b: MemoryRow; sim: number }[] =
    [];
  for (const p of capped) {
    const aLocked = p.a.source === "user_explicit";
    const bLocked = p.b.source === "user_explicit";
    if (aLocked && bLocked) continue;
    if (aLocked !== bLocked) {
      const extracted = aLocked ? p.b : p.a;
      const kept = aLocked ? p.a : p.b;
      autoDelete.push({ id: extracted.id, twinContent: kept.content });
      continue;
    }
    toAsk.push({ pairIndex: toAsk.length, a: p.a, b: p.b, sim: p.sim });
  }

  // LLM round for extracted/extracted pairs
  type Decision = {
    pairIndex: number;
    action: "merge" | "keep_both";
    keepId?: string;
    deleteId?: string;
    mergedContent?: string;
  };
  let decisions: Decision[] = [];
  if (toAsk.length > 0) {
    const payload = toAsk
      .map(
        (p) =>
          `Pair ${p.pairIndex} (similarity=${p.sim.toFixed(2)}):\n  A (id=${p.a.id}): ${p.a.content}\n  B (id=${p.b.id}): ${p.b.content}`
      )
      .join("\n\n");
    const startedAt = Date.now();
    process.stdout.write(
      `    dedup: asking LLM on ${toAsk.length} pair(s)... `
    );
    try {
      const res = await llmCompleteJSON<{ decisions?: Decision[] }>(
        DEDUP_SYSTEM_PROMPT,
        `Evaluate the following ${toAsk.length} candidate pair(s):\n\n${payload}`
      );
      console.log(`${Date.now() - startedAt}ms`);
      decisions = Array.isArray(res.decisions) ? res.decisions : [];
    } catch (err: any) {
      console.log(
        `FAILED (${Date.now() - startedAt}ms): ${err?.message || "unknown"}`
      );
      log.error({ userId, err }, "memory-dedup.llm-error");
    }
  }

  // Apply
  let merged = 0;
  let autoDeleted = 0;
  let rejected = 0;

  await db.transaction(async (tx) => {
    for (const d of autoDelete) {
      const result = await tx
        .update(userMemories)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(userMemories.id, d.id),
            eq(userMemories.userId, userId),
            eq(userMemories.source, "extracted"),
            isNull(userMemories.deletedAt)
          )
        )
        .returning({ id: userMemories.id });
      if (result.length > 0) autoDeleted++;
    }

    for (const dec of decisions) {
      if (dec.action !== "merge") continue;
      if (!dec.keepId || !dec.deleteId || !dec.mergedContent) continue;
      const pair = toAsk.find((p) => p.pairIndex === dec.pairIndex);
      if (!pair) continue;
      // keepId / deleteId must reference one of the pair's rows
      const validIds = new Set([pair.a.id, pair.b.id]);
      if (!validIds.has(dec.keepId) || !validIds.has(dec.deleteId)) {
        rejected++;
        continue;
      }
      // Both sides must still be extracted + active (someone may have locked them)
      const updatedKeep = await tx
        .update(userMemories)
        .set({
          content: dec.mergedContent,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(userMemories.id, dec.keepId),
            eq(userMemories.userId, userId),
            eq(userMemories.source, "extracted"),
            isNull(userMemories.deletedAt)
          )
        )
        .returning({ id: userMemories.id });
      if (updatedKeep.length === 0) {
        rejected++;
        continue;
      }
      await tx
        .update(userMemories)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(userMemories.id, dec.deleteId),
            eq(userMemories.userId, userId),
            eq(userMemories.source, "extracted"),
            isNull(userMemories.deletedAt)
          )
        );
      merged++;
    }
  });

  log.info(
    {
      userId,
      totalRows: rows.length,
      candidatePairs: candidates.length,
      askedLLM: toAsk.length,
      autoDeleted,
      merged,
      rejected,
    },
    "memory-dedup.result"
  );

  return {
    totalRows: rows.length,
    candidatePairs: candidates.length,
    askedLLM: toAsk.length,
    merged,
    autoDeleted,
    rejected,
  };
}

/**
 * Scanner job — enumerates users with enough active memories to bother and
 * enqueues a per-user dedup job. Runs on whatever schedule the worker installs
 * (see `index.ts`).
 */
export async function processMemoryDedupScan(queue: Queue) {
  const rows = await db
    .select({
      userId: userMemories.userId,
      n: sql<number>`count(*)`.mapWith(Number),
    })
    .from(userMemories)
    .where(isNull(userMemories.deletedAt))
    .groupBy(userMemories.userId);

  const targets = rows.filter((r) => r.n >= 2);
  log.info(
    { userCount: targets.length, totalScanned: rows.length },
    "memory-dedup-scan.start"
  );

  for (const t of targets) {
    await queue.add(
      "memory-dedup",
      { userId: t.userId },
      { removeOnComplete: 100, removeOnFail: 50 }
    );
  }
}
