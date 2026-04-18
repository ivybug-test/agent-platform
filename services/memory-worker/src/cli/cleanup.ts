/**
 * One-time bulk memory cleanup.
 *
 * For every user with active extracted memories:
 *   1) Detect the user's primary language from recent messages.
 *   2) If Chinese, batch-translate English memories to Chinese via LLM.
 *   3) Exhaustively dedup near-duplicate memories (run repeatedly until no
 *      further progress or a safety cap is hit).
 *
 * Usage (from services/memory-worker):
 *   pnpm cleanup
 *
 * Safe to re-run. Soft-deleted rows are skipped. Locked (user_explicit)
 * rows are never modified or removed — dedup only retires their extracted
 * twins.
 */

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), "../../.env") });

import { db, userMemories, sql as rawSql } from "@agent-platform/db";
import { isNull } from "drizzle-orm";
import { processMemoryTranslate } from "../jobs/memory-translate.js";
import { processMemoryDedup } from "../jobs/memory-dedup.js";

const MAX_DEDUP_PASSES = 50; // safety — should converge well before this

async function cleanupUser(userId: string): Promise<void> {
  console.log(`\n=== user ${userId} ===`);

  // Step 1: translate English → Chinese (if user is Chinese)
  try {
    const tr = await processMemoryTranslate({ userId });
    console.log(
      `  translate: lang=${tr.userLang} targets=${tr.targetCount} translated=${tr.translated} failed=${tr.failed}`
    );
  } catch (err) {
    console.error(`  translate FAILED:`, err);
  }

  // Step 2: exhaustive dedup
  let pass = 0;
  let totalMerged = 0;
  let totalAutoDeleted = 0;
  while (pass < MAX_DEDUP_PASSES) {
    pass++;
    try {
      const r = await processMemoryDedup({ userId });
      totalMerged += r.merged;
      totalAutoDeleted += r.autoDeleted;
      console.log(
        `  dedup pass ${pass}: rows=${r.totalRows} pairs=${r.candidatePairs} askedLLM=${r.askedLLM} merged=${r.merged} autoDeleted=${r.autoDeleted} rejected=${r.rejected}`
      );
      // Stop when no progress possible
      if (r.candidatePairs === 0) break;
      if (r.merged === 0 && r.autoDeleted === 0) {
        // Remaining candidates were all "keep_both" or rejected — stop
        break;
      }
    } catch (err) {
      console.error(`  dedup pass ${pass} FAILED:`, err);
      break;
    }
  }
  console.log(
    `  dedup summary: passes=${pass} merged=${totalMerged} autoDeleted=${totalAutoDeleted}`
  );
}

async function main(): Promise<void> {
  console.log("Bulk memory cleanup — translating + deduping all users.\n");

  // All users who have at least one active memory row
  const rows = await db
    .selectDistinct({ userId: userMemories.userId })
    .from(userMemories)
    .where(isNull(userMemories.deletedAt));

  console.log(`Found ${rows.length} user(s) with active memories.`);

  for (const { userId } of rows) {
    await cleanupUser(userId);
  }

  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error("cleanup fatal:", err);
  process.exit(1);
});
