import { db, roomMembers } from "@agent-platform/db";
import { and, eq } from "drizzle-orm";
import { publishUserEvent } from "@/lib/redis";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("web");

/**
 * Notify every user member of a room that activity just happened there.
 * Sidebar listeners use the `at` ISO string to update the room's
 * `lastActivityAt` and re-sort so the active room bubbles to the top.
 *
 * Fire-and-forget — failures are logged but never throw.
 */
export async function publishRoomActivity(
  roomId: string,
  at: Date = new Date()
): Promise<void> {
  try {
    const members = await db
      .select({ memberId: roomMembers.memberId })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.memberType, "user")
        )
      );

    const iso = at.toISOString();
    for (const m of members) {
      publishUserEvent(m.memberId, {
        type: "room-activity",
        roomId,
        at: iso,
      });
    }
  } catch (err) {
    log.warn({ roomId, err }, "publishRoomActivity.failed");
  }
}
