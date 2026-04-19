/**
 * One-time Pass A backfill: populate `user_memories.event_at` on existing
 * extracted rows by replaying them through the LLM.
 *
 * Rationale: Phase A added `event_at` but every pre-existing row has it NULL.
 * To give the time-range retrieval tool (`search_memories` from/to) coverage
 * over historical memories, we ask the LLM — per row — whether the content
 * describes a specific past event, and if so, what absolute date it maps to.
 *
 * Anchor for relative phrases (今天 / 昨天 / 刚才 / 上周) is the row's own
 * `created_at`. The memory-worker writes each row within ~5 minutes of the
 * triggering user message (5-min bucket), so created_at ≈ "when the user
 * said this".
 *
 * Safety:
 *   - Only `source='extracted'` rows are touched. user_explicit is a hard
 *     lock (user's own writes, never modified by any automated flow).
 *   - Pending third-party rows (authored_by != user_id AND confirmed_at NULL)
 *     are skipped — subject hasn't accepted them yet.
 *   - Tombstones (deleted_at IS NOT NULL) are skipped.
 *   - Content is NOT rewritten in this pass (that's optional Pass B).
 *   - Idempotent: rows that already have event_at are skipped.
 *
 * Usage (from services/memory-worker):
 *   pnpm backfill-event-at              # real run
 *   pnpm backfill-event-at --dry-run    # print proposals, don't write
 *
 * Cost: 1 LLM call per BATCH_SIZE rows. A few hundred rows → ~10 calls.
 */

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), "../../.env") });

import { db, userMemories } from "@agent-platform/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { llmCompleteJSON } from "../llm.js";

const BATCH_SIZE = 20;

const DRY_RUN = process.argv.includes("--dry-run");

interface Row {
  id: string;
  content: string;
  category: string;
  createdAt: Date;
}

interface Proposal {
  id: string;
  eventAt?: string;
  reason?: string;
}

const SYSTEM_PROMPT = `You are helping backfill an "event_at" timestamp on historical memory rows.

INPUT: a JSON array. Each item has { id, content, category, createdAt }.
- createdAt is when the memory row was written, which is within ~5 minutes of
  the user message that produced it. Treat createdAt as the "now" against
  which any relative time phrase inside content (今天 / 昨天 / 刚才 / 中午 /
  上周 / yesterday / just now / last week) should be resolved.

OUTPUT (strict JSON):
{
  "proposals": [
    { "id": "<uuid>", "eventAt": "2026-04-19" },          // resolved
    { "id": "<uuid>", "eventAt": "2026-04-19T12:00+08:00" },
    { "id": "<uuid>" }                                     // no event_at
  ]
}

RULES:
- Set eventAt ONLY when the fact clearly describes a specific point in time.
  Events, meals, trips, meetings, decisions — yes. Identity ("住在深圳"),
  preferences ("喜欢吃辣"), relationships ("弟弟叫志龙"), general opinions —
  NO eventAt (just return { "id": ... } with no eventAt field).
- Pattern / habitual facts ("经常不吃午饭", "每天早起") are NOT events; skip eventAt.
- Date-only is fine when the content doesn't specify a time of day. Examples:
    "今天没吃午饭"      (created 2026-04-05) → "2026-04-05"
    "昨天见了志龙"      (created 2026-04-05) → "2026-04-04"
    "刚才吃了火锅"      (created 2026-04-05 18:30) → "2026-04-05T18:00+08:00"
    "上周去了上海"      (created 2026-04-07) → "2026-03-31" (best-guess mid-week)
    "喜欢吃辣"          → no eventAt
    "2026-04-01 搬家"   → "2026-04-01" (already absolute, still extract it)
- If content itself already contains an ISO date ("2026-04-01 没吃午饭"),
  prefer that over createdAt math.
- If the phrase is ambiguous ("最近有点累"), no eventAt.
- category='event' is a strong hint that eventAt probably applies, but don't
  blindly fill it — only when content actually encodes a time.

If in doubt, omit eventAt. The null case is always safe; a wrong eventAt is
not.`;

function formatCreatedAt(d: Date): string {
  // Asia/Shanghai wall clock so the LLM is reasoning in the user's timezone.
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

/** Parse an LLM-supplied eventAt string (date or datetime) into a Date. */
function parseEventAt(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // Date-only: anchor to Asia/Shanghai noon (04:00 UTC) so UTC storage
    // doesn't push it onto the prior/next day.
    const d = new Date(`${s}T04:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

async function processBatch(
  batch: Row[]
): Promise<{ filled: number; skipped: number; invalid: number }> {
  const inputPayload = batch.map((r) => ({
    id: r.id,
    content: r.content,
    category: r.category,
    createdAt: formatCreatedAt(r.createdAt) + " (Asia/Shanghai)",
  }));

  const userPrompt = `Resolve event_at for these ${batch.length} memory rows. Return strict JSON per the system rules.

${JSON.stringify(inputPayload, null, 2)}`;

  let result: { proposals?: Proposal[] };
  try {
    result = await llmCompleteJSON<{ proposals?: Proposal[] }>(
      SYSTEM_PROMPT,
      userPrompt
    );
  } catch (err) {
    console.error("  LLM call failed for batch:", err);
    return { filled: 0, skipped: batch.length, invalid: 0 };
  }

  const proposals = Array.isArray(result.proposals) ? result.proposals : [];
  const proposalsById = new Map(proposals.map((p) => [p.id, p]));

  let filled = 0,
    skipped = 0,
    invalid = 0;

  for (const row of batch) {
    const p = proposalsById.get(row.id);
    if (!p || !p.eventAt) {
      skipped++;
      if (DRY_RUN) {
        console.log(`  SKIP  ${row.id.slice(0, 8)}  ${row.content.slice(0, 60)}`);
      }
      continue;
    }
    const parsed = parseEventAt(p.eventAt);
    if (!parsed) {
      invalid++;
      console.warn(
        `  BAD   ${row.id.slice(0, 8)}  eventAt="${p.eventAt}" from LLM did not parse`
      );
      continue;
    }

    if (DRY_RUN) {
      console.log(
        `  FILL  ${row.id.slice(0, 8)}  ${parsed.toISOString()}  "${row.content.slice(0, 60)}"  (written ${formatCreatedAt(row.createdAt)})`
      );
      filled++;
      continue;
    }

    // SQL-level source lock: even if we made a mistake upstream, the WHERE
    // clause guarantees user_explicit rows stay untouched.
    const res = await db
      .update(userMemories)
      .set({ eventAt: parsed, updatedAt: new Date() })
      .where(
        and(
          eq(userMemories.id, row.id),
          eq(userMemories.source, "extracted"),
          isNull(userMemories.eventAt)
        )
      )
      .returning({ id: userMemories.id });
    if (res.length > 0) {
      filled++;
    } else {
      // Row lost the race (someone filled event_at between query and update)
      // or source changed to user_explicit. Either way, nothing to report.
      skipped++;
    }
  }

  return { filled, skipped, invalid };
}

async function main(): Promise<void> {
  console.log(
    `Pass A backfill: populating event_at on historical extracted memories.` +
      (DRY_RUN ? " [DRY RUN — no DB writes]" : "")
  );
  console.log();

  // Eligibility (all three must hold):
  //   - source = 'extracted'       (user_explicit is locked)
  //   - deleted_at IS NULL         (no tombstones)
  //   - event_at  IS NULL          (idempotent — don't re-work done rows)
  //   - NOT pending                (authored_by_user_id null OR = user_id,
  //                                 OR confirmed_at not null)
  //
  // The "not pending" piece is implemented as: skip rows where
  // authored_by_user_id != user_id AND confirmed_at IS NULL. A single SQL
  // predicate is awkward with Drizzle's helpers, so we filter in app code.
  const rows = await db
    .select({
      id: userMemories.id,
      userId: userMemories.userId,
      authoredByUserId: userMemories.authoredByUserId,
      confirmedAt: userMemories.confirmedAt,
      content: userMemories.content,
      category: userMemories.category,
      createdAt: userMemories.createdAt,
    })
    .from(userMemories)
    .where(
      and(
        eq(userMemories.source, "extracted"),
        isNull(userMemories.deletedAt),
        isNull(userMemories.eventAt)
      )
    )
    .orderBy(userMemories.createdAt);

  const eligible: Row[] = rows
    .filter((r) => {
      // Skip pending third-party rows
      const isPending =
        r.authoredByUserId !== null &&
        r.authoredByUserId !== r.userId &&
        r.confirmedAt === null;
      return !isPending;
    })
    .map((r) => ({
      id: r.id,
      content: r.content,
      category: r.category,
      createdAt: r.createdAt,
    }));

  const pendingSkipped = rows.length - eligible.length;
  console.log(
    `Eligible rows: ${eligible.length}  ` +
      `(${rows.length} candidates, ${pendingSkipped} pending skipped)`
  );

  if (eligible.length === 0) {
    console.log("Nothing to do.");
    process.exit(0);
  }

  const batches: Row[][] = [];
  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    batches.push(eligible.slice(i, i + BATCH_SIZE));
  }
  console.log(`Batches: ${batches.length} (size=${BATCH_SIZE})\n`);

  const total = { filled: 0, skipped: 0, invalid: 0 };
  for (let i = 0; i < batches.length; i++) {
    console.log(`--- batch ${i + 1}/${batches.length} (${batches[i].length} rows) ---`);
    const r = await processBatch(batches[i]);
    total.filled += r.filled;
    total.skipped += r.skipped;
    total.invalid += r.invalid;
    console.log(
      `  batch done: filled=${r.filled} skipped=${r.skipped} invalid=${r.invalid}`
    );
  }

  console.log();
  console.log(
    `Done. filled=${total.filled} skipped=${total.skipped} invalid=${total.invalid}` +
      (DRY_RUN ? "  [dry run — nothing persisted]" : "")
  );

  // Sanity: how many rows still have event_at NULL now?
  if (!DRY_RUN) {
    const [remaining] = await db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(userMemories)
      .where(
        and(
          eq(userMemories.source, "extracted"),
          isNull(userMemories.deletedAt),
          isNull(userMemories.eventAt)
        )
      );
    console.log(`Remaining extracted+active rows with event_at NULL: ${remaining?.n ?? "?"}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("backfill-event-at fatal:", err);
  process.exit(1);
});
