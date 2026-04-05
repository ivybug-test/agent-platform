import { db, friendships, roomMembers } from "@agent-platform/db";
import { eq, and, or, inArray } from "drizzle-orm";

/** Get all accepted friend user IDs for a given user */
export async function getAcceptedFriendIds(userId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(friendships)
    .where(
      and(
        eq(friendships.status, "accepted"),
        or(
          eq(friendships.requesterId, userId),
          eq(friendships.addresseeId, userId)
        )
      )
    );

  return rows.map((r) =>
    r.requesterId === userId ? r.addresseeId : r.requesterId
  );
}

/** Add two users to each other's rooms (called on friend accept) */
export async function addFriendToRooms(userA: string, userB: string) {
  // Get rooms for each user
  const [roomsA, roomsB] = await Promise.all([
    db
      .select({ roomId: roomMembers.roomId })
      .from(roomMembers)
      .where(
        and(eq(roomMembers.memberId, userA), eq(roomMembers.memberType, "user"))
      ),
    db
      .select({ roomId: roomMembers.roomId })
      .from(roomMembers)
      .where(
        and(eq(roomMembers.memberId, userB), eq(roomMembers.memberType, "user"))
      ),
  ]);

  const roomIdsA = new Set(roomsA.map((r) => r.roomId));
  const roomIdsB = new Set(roomsB.map((r) => r.roomId));

  const toInsert: { roomId: string; memberId: string; memberType: "user" }[] =
    [];

  // Add userB to userA's rooms (if not already there)
  for (const roomId of roomIdsA) {
    if (!roomIdsB.has(roomId)) {
      toInsert.push({ roomId, memberId: userB, memberType: "user" });
    }
  }

  // Add userA to userB's rooms (if not already there)
  for (const roomId of roomIdsB) {
    if (!roomIdsA.has(roomId)) {
      toInsert.push({ roomId, memberId: userA, memberType: "user" });
    }
  }

  if (toInsert.length > 0) {
    await db.insert(roomMembers).values(toInsert);
  }
}
