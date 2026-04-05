import "@/lib/env";
import { db, rooms, roomMembers, agents } from "@agent-platform/db";
import { eq, and, inArray, ne } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";
import { getAcceptedFriendIds } from "@/lib/friends";

export async function GET() {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // Get room IDs where user is a member
  const memberships = await db
    .select({ roomId: roomMembers.roomId })
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.memberId, user.id),
        eq(roomMembers.memberType, "user")
      )
    );

  const roomIds = memberships.map((m) => m.roomId);
  if (roomIds.length === 0) return Response.json([]);

  const rows = await db
    .select()
    .from(rooms)
    .where(and(inArray(rooms.id, roomIds), ne(rooms.status, "archived")))
    .orderBy(rooms.createdAt)
    .limit(50);

  return Response.json(rows);
}

export async function POST() {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const [room] = await db
    .insert(rooms)
    .values({ name: "New Chat", createdBy: user.id })
    .returning();

  // Bind agent, user, and all friends to this room
  const [agent] = await db.select().from(agents).limit(1);
  const friendIds = await getAcceptedFriendIds(user.id);

  const members: { roomId: string; memberId: string; memberType: "user" | "agent" }[] = [
    { roomId: room.id, memberId: user.id, memberType: "user" },
    ...friendIds.map((id) => ({ roomId: room.id, memberId: id, memberType: "user" as const })),
  ];
  if (agent) {
    members.unshift({ roomId: room.id, memberId: agent.id, memberType: "agent" });
  }
  await db.insert(roomMembers).values(members);

  return Response.json(room, { status: 201 });
}
