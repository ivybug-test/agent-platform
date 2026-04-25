/**
 * One-off: re-run vision captioning on every image message whose
 * metadata.vision.caption is missing. Used after the Moonshot URL→base64 fix
 * to recover from the old broken caption pipeline.
 *
 *   pnpm --filter @agent-platform/memory-worker tsx src/cli/backfill-captions.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), "../../.env") });

import { db, messages } from "@agent-platform/db";
import { and, eq, sql } from "drizzle-orm";
import { llmCaptionImage } from "../llm.js";

async function main() {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.contentType, "image"),
        eq(messages.status, "completed"),
        sql`(metadata IS NULL OR (metadata -> 'vision' ->> 'caption') IS NULL)`
      )
    );

  console.log(`found ${rows.length} image rows missing caption`);
  let ok = 0;
  let fail = 0;
  for (const r of rows) {
    if (!r.content) continue;
    try {
      const { caption, model } = await llmCaptionImage(r.content);
      if (!caption) {
        console.warn(`empty caption for ${r.id}`);
        fail++;
        continue;
      }
      await db
        .update(messages)
        .set({
          metadata: {
            ...(r.metadata ?? {}),
            vision: {
              caption,
              model,
              generatedAt: new Date().toISOString(),
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(messages.id, r.id));
      console.log(`✓ ${r.id} → ${caption.slice(0, 60)}…`);
      ok++;
    } catch (err: any) {
      console.error(`✗ ${r.id}: ${err.message}`);
      fail++;
    }
  }
  console.log(`done: ${ok} ok, ${fail} failed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
