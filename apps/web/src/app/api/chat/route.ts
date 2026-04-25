import "@/lib/env";
import { NextRequest } from "next/server";
import { db, messages, rooms, roomMembers, agents } from "@agent-platform/db";
import { eq, and } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";
import { isRateLimited } from "@/lib/chat/rate-limit";
import { parseMention } from "@/lib/chat/mention";
import {
  loadChatContext,
  getRoomMemberNames,
  getLatestSummary,
  getRoomUsersMemories,
  getRoomMemories,
  getConfirmedRelationshipsForUser,
  buildSystemPrompt,
  buildLLMMessages,
} from "@/lib/chat/context";
import { streamAgentResponse } from "@/lib/chat/stream";
import { publishRoomEvent } from "@/lib/redis";
import { publishRoomActivity } from "@/lib/chat/room-activity";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("web");

async function getDefaultRoomAgent(roomId: string) {
  const [member] = await db
    .select()
    .from(roomMembers)
    .where(
      and(eq(roomMembers.roomId, roomId), eq(roomMembers.memberType, "agent"))
    )
    .limit(1);
  if (!member) return null;
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, member.memberId));
  return agent || null;
}

export async function POST(req: NextRequest) {
  const user = await getRequiredUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { roomId, content, model } = await req.json();
  if (!roomId || !content) {
    return new Response("Missing roomId or content", { status: 400 });
  }
  // Frontend sends "flash" | "pro" — anything else collapses to flash so a
  // stale client cookie can't poke at unknown variants.
  const mode: "flash" | "pro" = model === "pro" ? "pro" : "flash";

  if (isRateLimited(roomId)) {
    return Response.json({ error: "Too fast, please wait a moment" }, { status: 429 });
  }

  // Load room and agent
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
  const agent = await getDefaultRoomAgent(roomId);
  const agentName = agent?.name || "Assistant";

  // Parse @mention
  const { hasMention, cleanContent } = parseMention(content, agentName);

  // Save user message
  const [userMsg] = await db.insert(messages).values({
    roomId,
    senderType: "user",
    senderId: user.id,
    content: cleanContent,
    status: "completed",
  }).returning();

  // Broadcast user message to room via Redis
  publishRoomEvent({
    type: "user-message",
    roomId,
    message: {
      id: userMsg.id,
      senderType: "user",
      senderId: user.id,
      senderName: user.name || "User",
      content: cleanContent,
      status: "completed",
    },
  });

  // Notify every member's sidebar that this room just had activity, so it
  // bubbles up in their room list. Fire-and-forget.
  publishRoomActivity(roomId, userMsg.createdAt);

  // Check if agent should respond
  if (room?.autoReply === false && !hasMention) {
    return Response.json({ silent: true });
  }

  log.info({ roomId, userId: user.id, contentPreview: cleanContent.slice(0, 80) }, "chat.request");

  // Load context + memory
  const [
    { recentMessages, nameMap },
    memberNames,
    roomSummary,
    allUsersMemories,
    roomMems,
    roomMemberRows,
  ] = await Promise.all([
    loadChatContext(roomId),
    getRoomMemberNames(roomId),
    getLatestSummary(roomId),
    getRoomUsersMemories(roomId),
    getRoomMemories(roomId),
    db
      .select({ memberId: roomMembers.memberId })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, roomId),
          eq(roomMembers.memberType, "user")
        )
      ),
  ]);
  const currentUserName = nameMap.get(user.id) || "User";
  const roomMemberIds = roomMemberRows.map((r) => r.memberId);
  const relationships = await getConfirmedRelationshipsForUser(
    user.id,
    roomMemberIds
  );

  // Build prompt (6 layers)
  const systemContent = buildSystemPrompt({
    agentPrompt: agent?.systemPrompt || null,
    roomPrompt: room?.systemPrompt || null,
    roomName: room?.name || "Chat",
    memberNames,
    agentName,
    currentUserName,
    roomSummary,
    roomMemories: roomMems,
    relationships,
    allUsersMemories,
  });
  const llmMessages = buildLLMMessages(systemContent, recentMessages, nameMap);

  // Detect images in the recent context window. If any are present, route
  // this whole call through Kimi (vision-capable). Otherwise stay on the
  // default text-only provider (DeepSeek). The image stays addressable as
  // long as it sits in the recent window; once it scrolls out the agent
  // recovers context via the captioned summary / user_memory entries the
  // memory-worker fans out asynchronously.
  const hasImage = recentMessages.some((m) => m.contentType === "image");
  const provider = hasImage ? "kimi" : "deepseek";

  // Log full context for debugging
  const memoryCount = [...allUsersMemories.values()].reduce((s, m) => s + m.length, 0);
  log.info({
    roomId,
    messageCount: recentMessages.length,
    llmMessageCount: llmMessages.length,
    memoryCount,
    hasSummary: !!roomSummary,
    systemPromptLength: systemContent.length,
    provider,
    mode,
    hasImage,
  }, "chat.context");
  log.debug({ roomId, llmMessages }, "chat.llm-input");

  // Create agent message placeholder
  const [agentMsg] = await db
    .insert(messages)
    .values({
      roomId,
      senderType: "agent",
      senderId: agent?.id,
      content: "",
      status: "streaming",
    })
    .returning();

  // Stream response
  return streamAgentResponse(
    llmMessages,
    agentMsg.id,
    roomId,
    content,
    user.id,
    provider,
    mode
  );
}
