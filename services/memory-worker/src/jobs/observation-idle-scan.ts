import {
  db,
  messages,
  roomObservations,
  rooms,
} from "@agent-platform/db";
import { and, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import type { Queue } from "bullmq";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("memory-worker:observation-idle-scan");

// "Idle" means: no new messages in the past IDLE_THRESHOLD_MS. Default 30
// minutes — Letta dream-subagent pattern. Tuneable via env.
const IDLE_THRESHOLD_MS = Number(
  process.env.OBSERVATION_IDLE_THRESHOLD_MS || 30 * 60 * 1000
);
// Floor for "there's real unconsumed material": don't fire just because
// one greeting landed. Char-count comparable to room-observation's gate.
const MIN_UNCONSUMED_CHARS = Number(
  process.env.OBSERVATION_IDLE_MIN_CHARS || 3000
);

/** Scheduled job — fan out per-room room-observation jobs for rooms
 *  where:
 *    - the user has been idle ≥ IDLE_THRESHOLD_MS
 *    - there's unconsumed message material since the last observation
 *
 *  This is the **idle-time** trigger from the M4 plan. The other
 *  trigger is volume-based (every chat turn enqueues a room-observation
 *  job; the worker bails internally if <30k chars). Together they cover
 *  both "chatty users producing lots of material fast" and "quiet
 *  users whose sessions never cross the volume floor". */
export async function processObservationIdleScan(queue: Queue) {
  const idleCutoff = new Date(Date.now() - IDLE_THRESHOLD_MS);

  // For each room, compute:
  //   - last message timestamp (must be ≤ idleCutoff to qualify as idle)
  //   - latest observation period_end (or NULL)
  // Then the worker checks: any messages newer than period_end whose
  // total chars ≥ MIN_UNCONSUMED_CHARS. We do this in one query joining
  // a per-room aggregate against the latest observation.
  //
  // Drizzle's API for window functions / lateral joins is awkward —
  // raw SQL is clearer here.
  const candidates = await db.execute<{
    room_id: string;
    last_message_at: Date;
    last_observation_end: Date | null;
    unconsumed_chars: number;
  }>(sql`
    WITH room_last AS (
      SELECT
        room_id,
        MAX(created_at) AS last_message_at
      FROM messages
      WHERE status = 'completed' AND content <> ''
      GROUP BY room_id
    ),
    room_obs AS (
      SELECT DISTINCT ON (room_id) room_id, period_end AS last_observation_end
      FROM room_observations
      ORDER BY room_id, period_end DESC
    )
    SELECT
      rl.room_id::text AS room_id,
      rl.last_message_at,
      ro.last_observation_end,
      COALESCE(
        (
          SELECT SUM(LENGTH(m.content))::int
          FROM messages m
          WHERE m.room_id = rl.room_id
            AND m.status = 'completed'
            AND m.content <> ''
            AND (ro.last_observation_end IS NULL OR m.created_at > ro.last_observation_end)
        ),
        0
      ) AS unconsumed_chars
    FROM room_last rl
    LEFT JOIN room_obs ro ON ro.room_id = rl.room_id
    WHERE rl.last_message_at <= ${idleCutoff}
  `);

  const rows = (
    candidates as unknown as {
      rows?: Array<{
        room_id: string;
        unconsumed_chars: number;
      }>;
    }
  ).rows ?? (candidates as any);

  let enqueued = 0;
  for (const r of rows) {
    if (r.unconsumed_chars >= MIN_UNCONSUMED_CHARS) {
      // 5-minute dedup bucket per room — the volume-based trigger from
      // chat route uses 1-minute buckets, so this idle scan won't clash.
      await queue.add(
        "room-observation",
        { roomId: r.room_id },
        {
          jobId: `room-observation-idle-${r.room_id}-${Math.floor(
            Date.now() / (5 * 60 * 1000)
          )}`,
        }
      );
      enqueued++;
    }
  }

  log.info(
    {
      candidatesChecked: rows.length,
      enqueued,
      idleThresholdMs: IDLE_THRESHOLD_MS,
    },
    "observation.idle-scan-done"
  );
}
