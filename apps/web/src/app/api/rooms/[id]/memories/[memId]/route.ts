import "@/lib/env";
import { NextRequest } from "next/server";
import { db, roomMemories, roomMembers } from "@agent-platform/db";
import { and, eq, isNull } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";

const VALID_IMPORTANCES = ["high", "medium", "low"] as const;
type Importance = (typeof VALID_IMPORTANCES)[number];

async function requireRoomMember(userId: string, roomId: string) {
  const [membership] = await db
    .select({ id: roomMembers.id })
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.roomId, roomId),
        eq(roomMembers.memberId, userId),
        eq(roomMembers.memberType, "user")
      )
    );
  if (!membership) {
    return Response.json({ error: "not a room member" }, { status: 403 });
  }
  return null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; memId: string }> }
) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id: roomId, memId } = await params;
  const forbidden = await requireRoomMember(user.id, roomId);
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => null);
  const patch: { content?: string; importance?: Importance } = {};
  if (typeof body?.content === "string") {
    const trimmed = body.content.trim();
    if (!trimmed) return Response.json({ error: "content cannot be empty" }, { status: 400 });
    patch.content = trimmed;
  }
  if (body?.importance !== undefined) {
    if (!VALID_IMPORTANCES.includes(body.importance)) {
      return Response.json({ error: "invalid importance" }, { status: 400 });
    }
    patch.importance = body.importance;
  }
  if (Object.keys(patch).length === 0) {
    return Response.json({ error: "nothing to update" }, { status: 400 });
  }

  const [row] = await db
    .update(roomMemories)
    .set({ ...patch, source: "user_explicit", updatedAt: new Date() })
    .where(
      and(
        eq(roomMemories.id, memId),
        eq(roomMemories.roomId, roomId),
        isNull(roomMemories.deletedAt)
      )
    )
    .returning();

  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(row);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; memId: string }> }
) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id: roomId, memId } = await params;
  const forbidden = await requireRoomMember(user.id, roomId);
  if (forbidden) return forbidden;

  const [row] = await db
    .update(roomMemories)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(roomMemories.id, memId),
        eq(roomMemories.roomId, roomId),
        isNull(roomMemories.deletedAt)
      )
    )
    .returning({ id: roomMemories.id });

  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
