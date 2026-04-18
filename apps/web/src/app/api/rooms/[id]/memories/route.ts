import "@/lib/env";
import { NextRequest } from "next/server";
import { db, roomMemories, roomMembers } from "@agent-platform/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";

const VALID_IMPORTANCES = ["high", "medium", "low"] as const;
type Importance = (typeof VALID_IMPORTANCES)[number];

/** Require that the caller is a member of the room. Returns null if allowed, or a Response if forbidden. */
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

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id: roomId } = await params;
  const forbidden = await requireRoomMember(user.id, roomId);
  if (forbidden) return forbidden;

  const rows = await db
    .select({
      id: roomMemories.id,
      content: roomMemories.content,
      importance: roomMemories.importance,
      source: roomMemories.source,
      createdByUserId: roomMemories.createdByUserId,
      createdAt: roomMemories.createdAt,
      updatedAt: roomMemories.updatedAt,
    })
    .from(roomMemories)
    .where(
      and(eq(roomMemories.roomId, roomId), isNull(roomMemories.deletedAt))
    )
    .orderBy(desc(roomMemories.importance), desc(roomMemories.updatedAt));

  return Response.json(rows);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id: roomId } = await params;
  const forbidden = await requireRoomMember(user.id, roomId);
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => null);
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  const importance = (body?.importance as Importance) || "medium";
  if (!content) return Response.json({ error: "content required" }, { status: 400 });
  if (!VALID_IMPORTANCES.includes(importance)) {
    return Response.json({ error: "invalid importance" }, { status: 400 });
  }

  const [row] = await db
    .insert(roomMemories)
    .values({
      roomId,
      content,
      importance,
      createdByUserId: user.id,
      source: "user_explicit",
    })
    .returning();

  return Response.json(row, { status: 201 });
}
