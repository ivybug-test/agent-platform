import { db, messages } from "@agent-platform/db";
import { eq } from "drizzle-orm";
import { llmCaptionImage } from "../llm.js";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("memory-worker");

interface CaptionImageData {
  messageId: string;
}

/** Generate a vision caption for a single image message and store it on
 *  messages.metadata.vision. Idempotent — returns early if a caption is
 *  already present. The caption later gets picked up by the room-summary
 *  and user-memory extractors so the image's content survives once the
 *  raw URL scrolls out of the recent-message window. */
export async function processCaptionImage(data: CaptionImageData) {
  const { messageId } = data;

  const [msg] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId));

  if (!msg) {
    log.info({ messageId }, "caption.skip-missing");
    return;
  }
  if (msg.contentType !== "image" || !msg.content) {
    log.info({ messageId, contentType: msg.contentType }, "caption.skip-not-image");
    return;
  }
  if (msg.metadata?.vision?.caption) {
    log.info({ messageId }, "caption.skip-already-captioned");
    return;
  }

  const startedAt = Date.now();
  let caption = "";
  let model = "";
  try {
    const result = await llmCaptionImage(msg.content);
    caption = result.caption;
    model = result.model;
  } catch (err) {
    log.error({ messageId, err }, "caption.llm-error");
    throw err; // let BullMQ retry policy handle it
  }

  if (!caption) {
    log.warn({ messageId, durationMs: Date.now() - startedAt }, "caption.empty");
    return;
  }

  await db
    .update(messages)
    .set({
      metadata: {
        ...(msg.metadata ?? {}),
        vision: {
          caption,
          model,
          generatedAt: new Date().toISOString(),
        },
      },
      updatedAt: new Date(),
    })
    .where(eq(messages.id, messageId));

  log.info(
    {
      messageId,
      roomId: msg.roomId,
      captionLength: caption.length,
      model,
      durationMs: Date.now() - startedAt,
    },
    "caption.saved"
  );
}
