import "@/lib/env";
import { NextRequest } from "next/server";
import { db, messages, roomMembers } from "@agent-platform/db";
import { and, eq } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Single-message endpoint — used by ChatPanel's image-pending poll
 *  to track an in-flight generate_image when realtime-gateway isn't
 *  available (without the gateway, Redis pub/sub broadcasts of
 *  message-updated never reach the browser). The handler is scoped
 *  to room members; non-members get 403 even on a valid id. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  const [row] = await db.select().from(messages).where(eq(messages.id, id));
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });

  // Same-room scope: caller must be a member of the room this
  // message belongs to.
  const [member] = await db
    .select()
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.roomId, row.roomId),
        eq(roomMembers.memberId, user.id),
        eq(roomMembers.memberType, "user")
      )
    );
  if (!member) return Response.json({ error: "Forbidden" }, { status: 403 });

  return Response.json({
    message: {
      id: row.id,
      senderType: row.senderType,
      senderId: row.senderId,
      content: row.content,
      contentType: row.contentType,
      status: row.status,
      metadata: row.metadata,
      createdAt: row.createdAt,
    },
  });
}
