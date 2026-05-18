import {
  db,
  messages,
  roomObservations,
  users,
} from "@agent-platform/db";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { llmCompleteStrong } from "../llm.js";
import { createLogger } from "@agent-platform/logger";
import { buildObservationPrompt } from "../prompts/observation.js";
import {
  detectLanguage,
  formatWallClock,
  messageBody,
} from "../lib/format.js";

const log = createLogger("memory-worker:observation");

interface RoomObservationData {
  roomId: string;
}

// Trigger threshold (in chars, which is a coarse proxy for tokens —
// Chinese is roughly 1 char ≈ 1.5 tokens, English is 4 chars ≈ 1 token,
// so 30k chars caps around 20-45k tokens, fits well under the prompt
// cache window of every modern provider).
const ROOM_OBSERVATION_THRESHOLD_CHARS = Number(
  process.env.ROOM_OBSERVATION_THRESHOLD_CHARS || 30_000
);
// Hard cap on messages we'll feed to one observation pass. Prevents
// pathological cases where a quiet room suddenly gets a flood.
const MAX_MESSAGES_PER_OBSERVATION = 400;

export async function processRoomObservation(data: RoomObservationData) {
  const { roomId } = data;

  // Find the last observation — anything newer than its period_end is
  // unconsumed conversation material. If none exists, we cover from the
  // room's beginning.
  const [latest] = await db
    .select({ periodEnd: roomObservations.periodEnd })
    .from(roomObservations)
    .where(eq(roomObservations.roomId, roomId))
    .orderBy(desc(roomObservations.periodEnd))
    .limit(1);

  const sinceWhen = latest?.periodEnd;

  // Load unconsumed messages in chronological order. Excludes streaming /
  // failed rows so half-finished agent turns don't pollute the log.
  const unconsumed = await db
    .select()
    .from(messages)
    .where(
      sinceWhen
        ? and(
            eq(messages.roomId, roomId),
            gt(messages.createdAt, sinceWhen),
            eq(messages.status, "completed")
          )
        : and(
            eq(messages.roomId, roomId),
            eq(messages.status, "completed")
          )
    )
    .orderBy(messages.createdAt)
    .limit(MAX_MESSAGES_PER_OBSERVATION);

  if (unconsumed.length === 0) {
    log.info({ roomId }, "observation.skip-no-new-messages");
    return;
  }

  // Char-volume gate: don't run the LLM if the window is too small. The
  // trigger fires every chat turn (cheap Redis op); the worker's
  // threshold check is what saves LLM tokens.
  const totalChars = unconsumed.reduce(
    (sum, m) => sum + messageBody(m).length,
    0
  );
  if (totalChars < ROOM_OBSERVATION_THRESHOLD_CHARS) {
    log.info(
      {
        roomId,
        unconsumedMessages: unconsumed.length,
        totalChars,
        threshold: ROOM_OBSERVATION_THRESHOLD_CHARS,
      },
      "observation.skip-under-threshold"
    );
    return;
  }

  // Resolve sender names — same pattern as room-summary.
  const senderIds = [
    ...new Set(
      unconsumed
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

  // Build the conversation text with absolute timestamps + sender names.
  // Image messages substitute their stored caption (if landed) — same as
  // user-memory extraction.
  const convoText = unconsumed
    .map((m) => {
      const body = messageBody(m);
      const ts = formatWallClock(m.createdAt);
      if (m.senderType === "agent") return `[${ts}] Agent: ${body}`;
      const name = m.senderId ? nameMap.get(m.senderId) || "User" : "User";
      return `[${ts}] ${name}: ${body}`;
    })
    .join("\n");

  // Language matches the bulk of user messages in the window.
  const userOnly = unconsumed
    .filter((m) => m.senderType === "user")
    .map((m) => m.content)
    .join("\n");
  const language = detectLanguage(userOnly || convoText);

  const observation = await llmCompleteStrong(
    buildObservationPrompt(language),
    `Conversation window to log (newest at bottom):\n\n${convoText}\n\nProduce the observation log per the system rules. Output the lines only, no commentary.`
  );

  const trimmed = observation.trim();
  if (!trimmed || trimmed === "NONE") {
    log.info(
      { roomId, unconsumedMessages: unconsumed.length, totalChars },
      "observation.skip-llm-returned-none"
    );
    return;
  }

  const periodStart = unconsumed[0].createdAt;
  const periodEnd = unconsumed[unconsumed.length - 1].createdAt;

  await db.insert(roomObservations).values({
    roomId,
    content: trimmed,
    periodStart,
    periodEnd,
    messageCount: unconsumed.length,
    sourceCharCount: totalChars,
  });

  log.info(
    {
      roomId,
      unconsumedMessages: unconsumed.length,
      totalChars,
      observationLength: trimmed.length,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
    },
    "observation.saved"
  );
}
