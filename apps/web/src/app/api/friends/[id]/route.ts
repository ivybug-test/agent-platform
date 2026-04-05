import "@/lib/env";
import { NextRequest } from "next/server";
import { db, friendships } from "@agent-platform/db";
import { eq } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";
import { addFriendToRooms } from "@/lib/friends";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const [friendship] = await db
    .select()
    .from(friendships)
    .where(eq(friendships.id, id));

  if (!friendship) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  if (friendship.addresseeId !== user.id) {
    return Response.json(
      { error: "Only the recipient can accept" },
      { status: 403 }
    );
  }

  if (friendship.status === "accepted") {
    return Response.json({ error: "Already accepted" }, { status: 400 });
  }

  // Accept friendship
  const [updated] = await db
    .update(friendships)
    .set({ status: "accepted", updatedAt: new Date() })
    .where(eq(friendships.id, id))
    .returning();

  // Sync rooms between the two users
  await addFriendToRooms(friendship.requesterId, friendship.addresseeId);

  return Response.json(updated);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const [friendship] = await db
    .select()
    .from(friendships)
    .where(eq(friendships.id, id));

  if (!friendship) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  if (
    friendship.requesterId !== user.id &&
    friendship.addresseeId !== user.id
  ) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  await db.delete(friendships).where(eq(friendships.id, id));

  return new Response(null, { status: 204 });
}
