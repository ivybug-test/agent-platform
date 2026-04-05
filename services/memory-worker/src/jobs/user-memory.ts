import { db, messages, users, userMemories } from "@agent-platform/db";
import { eq, desc, and, inArray } from "drizzle-orm";
import { llmComplete } from "../llm.js";

interface UserMemoryData {
  roomId: string;
  userId: string;
}

export async function processUserMemory(data: UserMemoryData) {
  const { roomId, userId } = data;

  // Get user info
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return;

  // Get recent messages from this user in this room
  const recentUserMessages = await db
    .select()
    .from(messages)
    .where(and(eq(messages.roomId, roomId), eq(messages.senderId, userId)))
    .orderBy(desc(messages.createdAt))
    .limit(20);

  if (recentUserMessages.length < 3) {
    console.log(`user-memory: not enough messages from ${user.name}, skipping`);
    return;
  }

  // Get existing memories
  const existingMemories = await db
    .select()
    .from(userMemories)
    .where(eq(userMemories.userId, userId))
    .orderBy(desc(userMemories.createdAt))
    .limit(10);

  const existingText = existingMemories.length > 0
    ? existingMemories.map((m) => `- ${m.content}`).join("\n")
    : "No existing memories.";

  const messagesText = recentUserMessages
    .reverse()
    .map((m) => m.content)
    .join("\n");

  const result = await llmComplete(
    `You extract key facts about a user from their messages. Facts include: preferences, interests, background, goals, opinions, and any personal information they share.
Output one fact per line, prefixed with "- ". Only output NEW facts not already in existing memories. If there are no new facts, output "NONE".`,
    `User: ${user.name}\n\nExisting memories:\n${existingText}\n\nRecent messages from this user:\n${messagesText}\n\nExtract new facts:`
  );

  if (!result.trim() || result.trim() === "NONE") {
    console.log(`user-memory: no new memories for ${user.name}`);
    return;
  }

  // Parse individual memory items
  const newMemories = result
    .split("\n")
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line.length > 0 && line !== "NONE");

  if (newMemories.length > 0) {
    await db.insert(userMemories).values(
      newMemories.map((content) => ({ userId, content }))
    );
    console.log(
      `user-memory: saved ${newMemories.length} memories for ${user.name}`
    );
  }
}
