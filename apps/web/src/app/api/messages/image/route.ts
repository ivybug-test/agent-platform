import "@/lib/env";
import { NextRequest } from "next/server";
import { db, messages, roomMembers } from "@agent-platform/db";
import { and, eq } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";
import { publishRoomEvent } from "@/lib/redis";
import { pushCaptionJob } from "@/lib/queue";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("web");

export const dynamic = "force-dynamic";

const ALLOWED_HOST_SUFFIX = ".myqcloud.com";

export async function POST(req: NextRequest) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { roomId, imageUrl } = await req.json();
  if (!roomId || !imageUrl) {
    return Response.json({ error: "Missing roomId or imageUrl" }, { status: 400 });
  }

  // Sanity-check URL: must be https, must point at a cos.myqcloud.com host.
  try {
    const u = new URL(imageUrl);
    if (u.protocol !== "https:" || !u.hostname.endsWith(ALLOWED_HOST_SUFFIX)) {
      return Response.json({ error: "Invalid image URL" }, { status: 400 });
    }
  } catch {
    return Response.json({ error: "Invalid image URL" }, { status: 400 });
  }

  // Verify membership
  const [member] = await db
    .select()
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.roomId, roomId),
        eq(roomMembers.memberId, user.id),
        eq(roomMembers.memberType, "user")
      )
    );
  if (!member) return Response.json({ error: "Forbidden" }, { status: 403 });

  const [row] = await db
    .insert(messages)
    .values({
      roomId,
      senderType: "user",
      senderId: user.id,
      content: imageUrl,
      contentType: "image",
      status: "completed",
    })
    .returning();

  publishRoomEvent({
    type: "user-message",
    roomId,
    message: {
      id: row.id,
      senderType: "user",
      senderId: user.id,
      senderName: user.name || "User",
      content: imageUrl,
      contentType: "image",
      status: "completed",
    },
  });

  log.info({ roomId, userId: user.id, messageId: row.id }, "chat.image-message");

  // Fire a vision-caption job so the image can survive in long-term memory
  // once it scrolls out of the recent-message window. Non-blocking — the
  // chat path doesn't wait for caption to complete.
  pushCaptionJob(row.id).catch((err) => {
    log.error({ err, messageId: row.id }, "caption.enqueue-error");
  });

  return Response.json({
    message: {
      id: row.id,
      senderType: row.senderType,
      senderId: row.senderId,
      senderName: user.name || "User",
      content: row.content,
      contentType: row.contentType,
      createdAt: row.createdAt,
    },
  });
}
