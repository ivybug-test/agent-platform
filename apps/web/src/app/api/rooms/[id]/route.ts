import "@/lib/env";
import { NextRequest } from "next/server";
import { db, rooms, roomMembers, messages } from "@agent-platform/db";
import { eq } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";

// Archive a room
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { action } = await req.json();

  if (action === "archive") {
    await db
      .update(rooms)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(rooms.id, id));
    return Response.json({ ok: true });
  }

  if (action === "toggleAutoReply") {
    const [room] = await db.select().from(rooms).where(eq(rooms.id, id));
    if (!room) return Response.json({ error: "Not found" }, { status: 404 });
    const newValue = !room.autoReply;
    await db
      .update(rooms)
      .set({ autoReply: newValue, updatedAt: new Date() })
      .where(eq(rooms.id, id));
    return Response.json({ autoReply: newValue });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}

// Delete a room and its data
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  // Delete in order: messages → room_members → room
  await db.delete(messages).where(eq(messages.roomId, id));
  await db.delete(roomMembers).where(eq(roomMembers.roomId, id));
  await db.delete(rooms).where(eq(rooms.id, id));

  return new Response(null, { status: 204 });
}
