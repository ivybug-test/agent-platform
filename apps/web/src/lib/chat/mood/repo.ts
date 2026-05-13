import {
  db,
  agentUserMoods,
  agentUserAttitudeCounters,
} from "@agent-platform/db";
import { and, eq, sql } from "drizzle-orm";
import type { AttitudeItem, Mood } from "@agent-platform/types";
import { createLogger } from "@agent-platform/logger";
import {
  DEFAULT_FAVOR,
  DEFAULT_SELF_STATE,
  clampMood,
  computeDelta,
  sanitizeItems,
} from "./coefficients";

const log = createLogger("web");

/** Read current mood, defaulting when no row exists. We never INSERT a
 *  row just to read — defaults are returned cheaply and the row gets
 *  created on the first attitude event in applyMoodDelta. */
export async function getMood(
  agentId: string,
  userId: string
): Promise<Mood> {
  const [row] = await db
    .select({
      selfState: agentUserMoods.selfState,
      favor: agentUserMoods.favor,
    })
    .from(agentUserMoods)
    .where(
      and(eq(agentUserMoods.agentId, agentId), eq(agentUserMoods.userId, userId))
    )
    .limit(1);
  if (!row) {
    return { selfState: DEFAULT_SELF_STATE, favor: DEFAULT_FAVOR };
  }
  return { selfState: row.selfState, favor: row.favor };
}

/** Apply one stream's worth of attitude items to mood + counters.
 *  - Sanitizes items (drops malformed / target-violating ones).
 *  - Bumps strength_sum + event_count audit log per (attitude, target).
 *  - Reads current Self/Favor, applies the delta, clamps to [1,100],
 *    upserts agent_user_moods.
 *  Returns the new mood (or current mood if no valid items).
 *
 *  Errors are swallowed at the call site — failing mood update must
 *  not break the conversation. */
export async function applyMoodDelta(
  agentId: string,
  userId: string,
  rawItems: unknown
): Promise<Mood> {
  const items: AttitudeItem[] = sanitizeItems(rawItems);
  if (items.length === 0) {
    return getMood(agentId, userId);
  }

  return await db.transaction(async (tx) => {
    // Bump per-attitude-target audit counters. ON CONFLICT DO UPDATE
    // adds strength to existing row; falls back to INSERT on first hit.
    // Aggregate per (attitude,target) first so duplicate items in one
    // stream become a single SQL hit.
    const aggregated = new Map<
      string,
      { attitude: string; target: string; strengthSum: number; events: number }
    >();
    for (const it of items) {
      const key = `${it.type}:${it.target}`;
      const cur = aggregated.get(key);
      if (cur) {
        cur.strengthSum += it.strength;
        cur.events += 1;
      } else {
        aggregated.set(key, {
          attitude: it.type,
          target: it.target,
          strengthSum: it.strength,
          events: 1,
        });
      }
    }
    for (const a of aggregated.values()) {
      await tx
        .insert(agentUserAttitudeCounters)
        .values({
          agentId,
          userId,
          attitude: a.attitude,
          target: a.target,
          strengthSum: a.strengthSum,
          eventCount: a.events,
        })
        .onConflictDoUpdate({
          target: [
            agentUserAttitudeCounters.agentId,
            agentUserAttitudeCounters.userId,
            agentUserAttitudeCounters.attitude,
            agentUserAttitudeCounters.target,
          ],
          set: {
            strengthSum: sql`${agentUserAttitudeCounters.strengthSum} + ${a.strengthSum}`,
            eventCount: sql`${agentUserAttitudeCounters.eventCount} + ${a.events}`,
            updatedAt: new Date(),
          },
        });
    }

    // Read current mood inside the txn so concurrent appends don't
    // stomp each other. We rely on the row's PK lock under the upsert
    // for serialization within the same (agent,user) tuple.
    const [existing] = await tx
      .select({
        selfState: agentUserMoods.selfState,
        favor: agentUserMoods.favor,
      })
      .from(agentUserMoods)
      .where(
        and(
          eq(agentUserMoods.agentId, agentId),
          eq(agentUserMoods.userId, userId)
        )
      )
      .limit(1);
    const baseSelf = existing?.selfState ?? DEFAULT_SELF_STATE;
    const baseFavor = existing?.favor ?? DEFAULT_FAVOR;
    const { deltaSelf, deltaFavor } = computeDelta(items);
    const newSelf = clampMood(baseSelf + deltaSelf);
    const newFavor = clampMood(baseFavor + deltaFavor);

    if ((baseSelf + deltaSelf) !== newSelf && Math.abs(baseSelf + deltaSelf - newSelf) > 0.5) {
      log.warn(
        { agentId, userId, raw: baseSelf + deltaSelf, clamped: newSelf },
        "mood.self-state-clamped"
      );
    }
    if ((baseFavor + deltaFavor) !== newFavor && Math.abs(baseFavor + deltaFavor - newFavor) > 0.5) {
      log.warn(
        { agentId, userId, raw: baseFavor + deltaFavor, clamped: newFavor },
        "mood.favor-clamped"
      );
    }

    await tx
      .insert(agentUserMoods)
      .values({
        agentId,
        userId,
        selfState: newSelf,
        favor: newFavor,
      })
      .onConflictDoUpdate({
        target: [agentUserMoods.agentId, agentUserMoods.userId],
        set: {
          selfState: newSelf,
          favor: newFavor,
          updatedAt: new Date(),
        },
      });

    return { selfState: newSelf, favor: newFavor };
  });
}
