import { db, messages, roomMembers, users } from "@agent-platform/db";
import { eq, and, inArray } from "drizzle-orm";

/** Load recent messages and resolve sender names */
export async function loadChatContext(roomId: string) {
  const recentMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .orderBy(messages.createdAt)
    .limit(50);

  // Resolve sender names
  const senderIds = [
    ...new Set(
      recentMessages
        .filter((m) => m.senderType === "user" && m.senderId)
        .map((m) => m.senderId!)
    ),
  ];
  const senderUsers =
    senderIds.length > 0
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, senderIds))
      : [];
  const nameMap = new Map(senderUsers.map((u) => [u.id, u.name]));

  return { recentMessages, nameMap };
}

/** Get all user member names in a room */
export async function getRoomMemberNames(roomId: string): Promise<string[]> {
  const memberRows = await db
    .select({ memberId: roomMembers.memberId })
    .from(roomMembers)
    .where(
      and(eq(roomMembers.roomId, roomId), eq(roomMembers.memberType, "user"))
    );
  const memberIds = memberRows.map((m) => m.memberId);
  if (memberIds.length === 0) return [];

  const memberUsers = await db
    .select({ name: users.name })
    .from(users)
    .where(inArray(users.id, memberIds));
  return memberUsers.map((u) => u.name);
}

/** Build the 3-layer system prompt */
export function buildSystemPrompt(
  agentPrompt: string | null,
  roomPrompt: string | null,
  roomName: string,
  memberNames: string[],
  agentName: string,
  currentUserName: string
): string {
  return [
    // Layer 1: Agent identity
    agentPrompt || "You are a helpful assistant.",
    // Layer 2: Room context
    [
      roomPrompt,
      `Room: "${roomName}". Members: ${memberNames.join(", ")}.`,
    ]
      .filter(Boolean)
      .join("\n"),
    // Layer 3: User context
    `You are an AI assistant in this group chat. Your name is ${agentName}.`
      + `\nUser messages are prefixed with their name, e.g. 'Alice: hello'.`
      + `\nThe user currently talking to you is ${currentUserName}.`
      + `\nReply as the assistant. Never pretend to be a user. Never prefix your reply with a name.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Build messages array for LLM */
export function buildLLMMessages(
  systemContent: string,
  recentMessages: { senderType: string; senderId: string | null; content: string }[],
  nameMap: Map<string, string>
) {
  return [
    { role: "system" as const, content: systemContent },
    ...recentMessages.map((m) => {
      if (m.senderType === "user") {
        const name = m.senderId ? nameMap.get(m.senderId) || "User" : "User";
        return { role: "user" as const, content: `${name}: ${m.content}` };
      }
      return { role: "assistant" as const, content: m.content };
    }),
  ];
}
