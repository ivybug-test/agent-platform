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
  buildSystemPrompt,
  buildLLMMessages,
} from "@/lib/chat/context";
import { streamAgentResponse } from "@/lib/chat/stream";

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

  const { roomId, content } = await req.json();
  if (!roomId || !content) {
    return new Response("Missing roomId or content", { status: 400 });
  }

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
  await db.insert(messages).values({
    roomId,
    senderType: "user",
    senderId: user.id,
    content: cleanContent,
    status: "completed",
  });

  // Check if agent should respond
  if (room?.autoReply === false && !hasMention) {
    return Response.json({ silent: true });
  }

  // Load context
  const { recentMessages, nameMap } = await loadChatContext(roomId);
  const currentUserName = nameMap.get(user.id) || "User";
  const memberNames = await getRoomMemberNames(roomId);

  // Build prompt
  const systemContent = buildSystemPrompt(
    agent?.systemPrompt || null,
    room?.systemPrompt || null,
    room?.name || "Chat",
    memberNames,
    agentName,
    currentUserName
  );
  const llmMessages = buildLLMMessages(systemContent, recentMessages, nameMap);

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
  return streamAgentResponse(llmMessages, agentMsg.id, roomId, content);
}
