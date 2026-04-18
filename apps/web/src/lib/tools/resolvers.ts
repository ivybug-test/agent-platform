import { db, roomMembers, users } from "@agent-platform/db";
import { and, eq, inArray, ilike } from "drizzle-orm";

/**
 * Find a user that (a) is a member of the given room and (b) matches the
 * display name (case-insensitive, exact match). Returns null if no match or
 * multiple matches. Used to translate tool arguments like
 * `remember({ subjectName: "Bob" })` into a concrete user_id.
 */
export async function resolveRoomMemberByName(
  roomId: string,
  name: string
): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const memberRows = await db
    .select({ memberId: roomMembers.memberId })
    .from(roomMembers)
    .where(
      and(eq(roomMembers.roomId, roomId), eq(roomMembers.memberType, "user"))
    );
  const memberIds = memberRows.map((r) => r.memberId);
  if (memberIds.length === 0) return null;

  const matches = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, memberIds), ilike(users.name, trimmed)));

  if (matches.length !== 1) return null;
  return matches[0].id;
}
