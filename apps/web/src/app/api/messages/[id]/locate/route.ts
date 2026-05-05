import "@/lib/env";
import { NextRequest } from "next/server";
import { db, messages, roomMembers } from "@agent-platform/db";
import { and, eq, lt, count } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Locate a message by id without scrolling 12+ pages of history. The
 *  client uses the response to (a) verify the agent didn't cite a
 *  msgId from a different room (412 Precondition Failed), and (b)
 *  jump-by-position rather than load-older-until-found.
 *
 *  Returns:
 *    200 { roomId, createdAt, olderCount }  — message exists, caller is a member
 *    403                                     — message exists but caller isn't in that room
 *    404                                     — no such message id
 *  olderCount is "how many other messages in the same room are older
 *  than this one"; the client can use it to size the load-older budget
 *  precisely. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  const [target] = await db
    .select({
      id: messages.id,
      roomId: messages.roomId,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.id, id))
    .limit(1);
  if (!target) return Response.json({ error: "Not found" }, { status: 404 });

  const [member] = await db
    .select({ memberId: roomMembers.memberId })
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.roomId, target.roomId),
        eq(roomMembers.memberId, user.id),
        eq(roomMembers.memberType, "user")
      )
    )
    .limit(1);
  if (!member) return Response.json({ error: "Forbidden" }, { status: 403 });

  const [olderRow] = await db
    .select({ c: count() })
    .from(messages)
    .where(
      and(
        eq(messages.roomId, target.roomId),
        lt(messages.createdAt, target.createdAt)
      )
    );
  const olderCount = Number(olderRow?.c ?? 0);

  return Response.json({
    roomId: target.roomId,
    createdAt: target.createdAt,
    olderCount,
  });
}
