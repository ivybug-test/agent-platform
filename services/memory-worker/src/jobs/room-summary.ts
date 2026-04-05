import { db, messages, roomSummaries } from "@agent-platform/db";
import { eq, desc } from "drizzle-orm";
import { llmComplete } from "../llm.js";

interface RoomSummaryData {
  roomId: string;
}

const SUMMARY_THRESHOLD = 20; // Generate summary every N messages

export async function processRoomSummary(data: RoomSummaryData) {
  const { roomId } = data;

  // Count messages since last summary
  const [lastSummary] = await db
    .select()
    .from(roomSummaries)
    .where(eq(roomSummaries.roomId, roomId))
    .orderBy(desc(roomSummaries.createdAt))
    .limit(1);

  const recentMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .orderBy(messages.createdAt)
    .limit(100);

  // Only summarize if enough new messages
  const msgCount = recentMessages.length;
  const lastCount = lastSummary?.messageCount
    ? parseInt(lastSummary.messageCount)
    : 0;

  if (msgCount - lastCount < SUMMARY_THRESHOLD) {
    console.log(`room-summary: only ${msgCount - lastCount} new messages, skipping`);
    return;
  }

  // Build conversation text
  const convoText = recentMessages
    .map((m) => {
      const role = m.senderType === "agent" ? "Assistant" : "User";
      return `${role}: ${m.content}`;
    })
    .join("\n");

  const previousSummary = lastSummary?.content || "No previous summary.";

  const summary = await llmComplete(
    "You are a conversation summarizer. Create a concise summary that captures the key topics, decisions, and important information from this conversation. Keep it under 300 words.",
    `Previous summary:\n${previousSummary}\n\nRecent conversation:\n${convoText}\n\nCreate an updated summary:`
  );

  if (summary.trim()) {
    await db.insert(roomSummaries).values({
      roomId,
      content: summary.trim(),
      messageCount: String(msgCount),
    });
    console.log(`room-summary: saved summary for room ${roomId.slice(0, 8)}`);
  }
}
