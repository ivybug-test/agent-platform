import { db, messages, roomMembers, users, roomSummaries, userMemories } from "@agent-platform/db";
import { eq, and, inArray, desc } from "drizzle-orm";

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

/** Get latest room summary */
export async function getLatestSummary(roomId: string): Promise<string | null> {
  const [summary] = await db
    .select()
    .from(roomSummaries)
    .where(eq(roomSummaries.roomId, roomId))
    .orderBy(desc(roomSummaries.createdAt))
    .limit(1);
  return summary?.content || null;
}

/** Get user memories */
export async function getUserMemories(userId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(userMemories)
    .where(eq(userMemories.userId, userId))
    .orderBy(desc(userMemories.createdAt))
    .limit(20);
  return rows.map((r) => r.content);
}

/** Build the 6-layer system prompt (per CLAUDE.md context strategy) */
export function buildSystemPrompt(opts: {
  agentPrompt: string | null;
  roomPrompt: string | null;
  roomName: string;
  memberNames: string[];
  agentName: string;
  currentUserName: string;
  roomSummary: string | null;
  userMemories: string[];
}): string {
  return [
    // Layer 1: Agent identity (system prompt)
    opts.agentPrompt || "You are a helpful assistant.",
    // Layer 2: Room rules (room system_prompt)
    [
      opts.roomPrompt,
      `Room: "${opts.roomName}". Members: ${opts.memberNames.join(", ")}.`,
    ]
      .filter(Boolean)
      .join("\n"),
    // Layer 3: User memory
    opts.userMemories.length > 0
      ? `What you know about ${opts.currentUserName}:\n${opts.userMemories.map((m) => `- ${m}`).join("\n")}`
      : null,
    // Layer 4: Room summary
    opts.roomSummary
      ? `Previous conversation summary:\n${opts.roomSummary}`
      : null,
    // Layer 5: (recent messages are added separately as user/assistant turns)
    // Layer 6: User context + rules
    `You are an AI assistant in this group chat. Your name is ${opts.agentName}.`
      + `\nUser messages are prefixed with their name, e.g. 'Alice: hello'.`
      + `\nThe user currently talking to you is ${opts.currentUserName}.`
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
