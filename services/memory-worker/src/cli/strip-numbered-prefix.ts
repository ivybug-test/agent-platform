/**
 * One-off cleanup: strip leading "N. " numbered-list prefixes from historical
 * extracted memories.
 *
 * An earlier extraction prompt sometimes returned its actions as a numbered
 * list, and the whole "12. ..." line ended up stored as content. The current
 * prompt no longer produces this shape, so this is strictly stale pollution.
 *
 * Pure regex, no LLM:
 *   "^\s*\d+\.\s+" → ""
 *
 * Safety:
 *   - Only touches `source='extracted'` rows. user_explicit is locked.
 *   - Skips tombstones (deleted_at IS NOT NULL).
 *   - Idempotent (second run matches nothing).
 *
 * Usage (from services/memory-worker):
 *   pnpm strip-numbered-prefix --dry-run   # preview affected rows
 *   pnpm strip-numbered-prefix             # real run
 */

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), "../../.env") });

import { db, userMemories } from "@agent-platform/db";
import { and, eq, isNull, sql } from "drizzle-orm";

const DRY_RUN = process.argv.includes("--dry-run");
const PREFIX_RE = /^\s*\d+\.\s+/;

async function main(): Promise<void> {
  console.log(
    `Strip numbered prefixes from extracted memory content.` +
      (DRY_RUN ? "  [DRY RUN — no DB writes]" : "")
  );
  console.log();

  // Postgres regex operator `~` matches the same pattern the app-side regex
  // uses, so the DB-side filter and the in-code regex agree.
  const candidates = await db
    .select({
      id: userMemories.id,
      content: userMemories.content,
    })
    .from(userMemories)
    .where(
      and(
        eq(userMemories.source, "extracted"),
        isNull(userMemories.deletedAt),
        sql`${userMemories.content} ~ '^\\s*\\d+\\.\\s+'`
      )
    );

  console.log(`Matched rows: ${candidates.length}`);
  if (candidates.length === 0) {
    console.log("Nothing to do.");
    process.exit(0);
  }

  let fixed = 0;
  let unchanged = 0;

  for (const row of candidates) {
    const before = row.content;
    const after = before.replace(PREFIX_RE, "");
    if (after === before) {
      // Defensive: the DB regex matched but the JS regex didn't. Skip
      // rather than silently mangle.
      unchanged++;
      continue;
    }

    if (DRY_RUN) {
      console.log(
        `  ${row.id.slice(0, 8)}  "${before.slice(0, 80)}"  →  "${after.slice(0, 80)}"`
      );
      fixed++;
      continue;
    }

    // SQL source lock as a belt-and-suspenders guard on top of the WHERE
    // filter above. A user_explicit row must never be rewritten by any
    // automated flow.
    const res = await db
      .update(userMemories)
      .set({ content: after, updatedAt: new Date() })
      .where(
        and(
          eq(userMemories.id, row.id),
          eq(userMemories.source, "extracted")
        )
      )
      .returning({ id: userMemories.id });
    if (res.length > 0) fixed++;
    else unchanged++;
  }

  console.log();
  console.log(
    `Done. fixed=${fixed} unchanged=${unchanged}` +
      (DRY_RUN ? "  [dry run — nothing persisted]" : "")
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("strip-numbered-prefix fatal:", err);
  process.exit(1);
});
