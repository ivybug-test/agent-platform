import { db, messages, roomSummaries, users } from "@agent-platform/db";
import { eq, desc, inArray } from "drizzle-orm";
import { llmComplete } from "../llm.js";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("memory-worker");

/** Render a message's body for inclusion in extraction prompts. For image
 *  messages, prefer the asynchronously generated vision caption; if it
 *  hasn't landed yet, fall back to a placeholder so downstream models know
 *  an image existed without being given the raw URL. */
function messageBody(m: {
  content: string;
  contentType: string;
  metadata: unknown;
}): string {
  if (m.contentType !== "image") return m.content;
  const cap =
    (m.metadata as { vision?: { caption?: string } } | null)?.vision?.caption;
  return cap ? `[image: ${cap}]` : "[image: (caption pending)]";
}

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
    log.info({ roomId, newMessages: msgCount - lastCount }, "memory.skip-summary");
    return;
  }

  // Resolve sender names for user messages
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

  // Build conversation text with real user names. Image messages are
  // substituted with their caption (if generated yet) so the summarizer can
  // include image context.
  const convoText = recentMessages
    .map((m) => {
      const body = messageBody(m);
      if (m.senderType === "agent") return `Agent: ${body}`;
      const name = m.senderId ? nameMap.get(m.senderId) || "User" : "User";
      return `${name}: ${body}`;
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
    log.info({ roomId, summaryLength: summary.trim().length, messageCount: msgCount }, "memory.summary-saved");
  }
}
