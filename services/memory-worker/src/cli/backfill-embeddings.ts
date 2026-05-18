/**
 * One-time M1 backfill: populate the `embedding` column on existing
 * user_memories / room_memories / messages rows.
 *
 * Why: Phase α M1 just added the `embedding vector(1536)` columns and an
 * HNSW index over them. The index is built but every historical row has
 * embedding NULL, which means semantic retrieval / dedup will see only
 * brand-new rows until this script catches up.
 *
 * Strategy:
 *   - Iterate each table in batches of BATCH_SIZE rows where embedding IS NULL
 *   - For messages: only embed completed text messages (skip streaming /
 *     failed / image placeholders without captions)
 *   - One embedding API call per batch (OpenAI accepts up to 2048 inputs)
 *   - Sleep BATCH_SLEEP_MS between batches to be polite to the API and DB
 *
 * Safety:
 *   - Idempotent: rows with embedding already set are skipped (WHERE clause)
 *   - --dry-run prints what would happen, no writes
 *   - Per-table flags --skip-user-memories / --skip-room-memories /
 *     --skip-messages let you resume if one table blew up
 *
 * Usage (from services/memory-worker):
 *   pnpm backfill-embeddings              # full run
 *   pnpm backfill-embeddings --dry-run    # plan only
 *   pnpm backfill-embeddings --skip-messages  # do memories first, messages later
 */

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), "../../.env") });

import {
  db,
  userMemories,
  roomMemories,
  messages,
} from "@agent-platform/db";
import { and, eq, isNull, sql, inArray } from "drizzle-orm";
import { embedBatch } from "../embeddings.js";
import { messageBody } from "../lib/format.js";

const BATCH_SIZE = 64;
const BATCH_SLEEP_MS = 250;

const DRY_RUN = process.argv.includes("--dry-run");
const SKIP_USER = process.argv.includes("--skip-user-memories");
const SKIP_ROOM = process.argv.includes("--skip-room-memories");
const SKIP_MSG = process.argv.includes("--skip-messages");

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function backfillUserMemories(): Promise<{ filled: number; failed: number }> {
  console.log("\n=== user_memories ===");
  let filled = 0;
  let failed = 0;
  let pageNo = 0;

  // Loop because each iteration changes which rows have NULL embedding.
  while (true) {
    const rows = await db
      .select({
        id: userMemories.id,
        content: userMemories.content,
      })
      .from(userMemories)
      .where(
        and(
          isNull(userMemories.embedding),
          isNull(userMemories.deletedAt)
        )
      )
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;
    pageNo++;

    if (DRY_RUN) {
      console.log(
        `  [dry] page ${pageNo}: would embed ${rows.length} rows (e.g. "${rows[0].content.slice(0, 50)}")`
      );
      // Avoid infinite loop in dry-run: bail after one page so we just show a sample
      break;
    }

    let vectors: (number[] | null)[];
    try {
      vectors = await embedBatch(rows.map((r) => r.content));
    } catch (err) {
      console.error(`  page ${pageNo}: embedBatch failed:`, err);
      failed += rows.length;
      // Don't bump cursor — we'll retry next pass. But we also need to
      // break to avoid spinning forever on the same failing rows.
      break;
    }

    for (let i = 0; i < rows.length; i++) {
      const v = vectors[i];
      if (!v) continue; // empty content → skip
      await db
        .update(userMemories)
        .set({ embedding: v })
        .where(eq(userMemories.id, rows[i].id));
      filled++;
    }

    console.log(
      `  page ${pageNo}: filled ${rows.length} (running total ${filled})`
    );
    await sleep(BATCH_SLEEP_MS);
  }

  return { filled, failed };
}

async function backfillRoomMemories(): Promise<{ filled: number; failed: number }> {
  console.log("\n=== room_memories ===");
  let filled = 0;
  let failed = 0;
  let pageNo = 0;

  while (true) {
    const rows = await db
      .select({
        id: roomMemories.id,
        content: roomMemories.content,
      })
      .from(roomMemories)
      .where(
        and(isNull(roomMemories.embedding), isNull(roomMemories.deletedAt))
      )
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;
    pageNo++;

    if (DRY_RUN) {
      console.log(`  [dry] page ${pageNo}: would embed ${rows.length} rows`);
      break;
    }

    let vectors: (number[] | null)[];
    try {
      vectors = await embedBatch(rows.map((r) => r.content));
    } catch (err) {
      console.error(`  page ${pageNo}: embedBatch failed:`, err);
      failed += rows.length;
      break;
    }

    for (let i = 0; i < rows.length; i++) {
      const v = vectors[i];
      if (!v) continue;
      await db
        .update(roomMemories)
        .set({ embedding: v })
        .where(eq(roomMemories.id, rows[i].id));
      filled++;
    }

    console.log(
      `  page ${pageNo}: filled ${rows.length} (running total ${filled})`
    );
    await sleep(BATCH_SLEEP_MS);
  }

  return { filled, failed };
}

async function backfillMessages(): Promise<{ filled: number; failed: number }> {
  console.log("\n=== messages (completed only) ===");
  let filled = 0;
  let failed = 0;
  let pageNo = 0;

  while (true) {
    // Only completed messages are stable enough to embed. Streaming /
    // failed rows would force a re-embed once they settle.
    const rows = await db
      .select({
        id: messages.id,
        content: messages.content,
        contentType: messages.contentType,
        metadata: messages.metadata,
      })
      .from(messages)
      .where(
        and(isNull(messages.embedding), eq(messages.status, "completed"))
      )
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;
    pageNo++;

    const texts = rows.map((r) =>
      messageBody({
        content: r.content,
        contentType: r.contentType,
        metadata: r.metadata,
      })
    );

    if (DRY_RUN) {
      console.log(`  [dry] page ${pageNo}: would embed ${rows.length} messages`);
      break;
    }

    let vectors: (number[] | null)[];
    try {
      vectors = await embedBatch(texts);
    } catch (err) {
      console.error(`  page ${pageNo}: embedBatch failed:`, err);
      failed += rows.length;
      break;
    }

    // Filter out positions where text was empty — leave their embedding NULL.
    const updates: { id: string; v: number[] }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const v = vectors[i];
      if (v) updates.push({ id: rows[i].id, v });
    }

    // For pure-empty rows that didn't get embeddings, mark them with a
    // sentinel zero-vector so the WHERE embedding IS NULL loop terminates.
    // We don't bother — empty messages should be rare; instead, exclude
    // them by content length on the next pass.
    if (updates.length === 0 && rows.length > 0) {
      // All-empty page: skip these rows by marking with zero vector so we
      // don't loop forever. Use a single bulk UPDATE.
      const zero = new Array(1536).fill(0);
      await db
        .update(messages)
        .set({ embedding: zero })
        .where(
          inArray(
            messages.id,
            rows.map((r) => r.id)
          )
        );
      console.log(`  page ${pageNo}: ${rows.length} empty rows marked with zero-vector`);
      continue;
    }

    for (const u of updates) {
      await db
        .update(messages)
        .set({ embedding: u.v })
        .where(eq(messages.id, u.id));
      filled++;
    }

    // Mark any non-embedded rows in this page with zero-vector so the
    // next iteration won't see them again.
    const embeddedIds = new Set(updates.map((u) => u.id));
    const leftover = rows.filter((r) => !embeddedIds.has(r.id)).map((r) => r.id);
    if (leftover.length > 0) {
      const zero = new Array(1536).fill(0);
      await db
        .update(messages)
        .set({ embedding: zero })
        .where(inArray(messages.id, leftover));
    }

    console.log(
      `  page ${pageNo}: filled ${updates.length}/${rows.length} (running total ${filled})`
    );
    await sleep(BATCH_SLEEP_MS);
  }

  return { filled, failed };
}

async function main() {
  console.log(
    `M1 backfill: populating embeddings on user_memories / room_memories / messages.` +
      (DRY_RUN ? " [DRY RUN]" : "")
  );

  // Pre-count for visibility
  const [umCount] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(userMemories)
    .where(and(isNull(userMemories.embedding), isNull(userMemories.deletedAt)));
  const [rmCount] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(roomMemories)
    .where(and(isNull(roomMemories.embedding), isNull(roomMemories.deletedAt)));
  const [msgCount] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(messages)
    .where(and(isNull(messages.embedding), eq(messages.status, "completed")));

  console.log(
    `Eligible: user_memories=${umCount?.n ?? "?"}  room_memories=${rmCount?.n ?? "?"}  messages=${msgCount?.n ?? "?"}`
  );

  const totals = { filled: 0, failed: 0 };
  if (!SKIP_USER) {
    const r = await backfillUserMemories();
    totals.filled += r.filled;
    totals.failed += r.failed;
  }
  if (!SKIP_ROOM) {
    const r = await backfillRoomMemories();
    totals.filled += r.filled;
    totals.failed += r.failed;
  }
  if (!SKIP_MSG) {
    const r = await backfillMessages();
    totals.filled += r.filled;
    totals.failed += r.failed;
  }

  console.log(
    `\nAll done. filled=${totals.filled} failed=${totals.failed}` +
      (DRY_RUN ? "  [dry — nothing persisted]" : "")
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("backfill-embeddings fatal:", err);
  process.exit(1);
});
