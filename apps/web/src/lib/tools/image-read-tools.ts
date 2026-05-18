import { db, messages, roomMembers, userMemories } from "@agent-platform/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { createLogger } from "@agent-platform/logger";
import { visibleToSubject } from "@/lib/memory-filters";
import type { ToolHandler } from "./index";

const log = createLogger("web");

/** M4.5 — look up user memories that semantically relate to an image
 *  caption. The cure for "看到不联想":the model sees a cat photo, gets
 *  caption "一只布偶猫", and should automatically recall that the user
 *  has a布偶猫 named 邦邦 — without having to *decide* to search memory.
 *
 *  Implementation: pg_trgm similarity against user_memories.content.
 *  Low threshold (0.05) because Chinese trigram overlap is sparse. We
 *  let the LLM judge relevance on the agent side; surfacing a couple
 *  of weak hits is better than zero. Top 5 by similarity * importance.
 *
 *  M5 upgrade path: replace trgm with cosine over the embedding column.
 *  Trgm here is the "good enough until then" stand-in. */
async function findRelatedMemoriesForCaption(
  userId: string,
  caption: string
): Promise<{ id: string; content: string; importance: string; similarity: number }[]> {
  if (!caption || caption.length < 3) return [];
  // Trgm similarity isn't bidirectional in scoring — short captions
  // matched against long memories will score low. Boost by also taking
  // the max() of trgm similarity from BOTH directions (memory→caption
  // and caption→memory). pg_trgm `similarity(a,b)` is already symmetric
  // so one call suffices; we just need a low threshold.
  const SIM_THRESHOLD = 0.05;
  const rows = await db
    .select({
      id: userMemories.id,
      content: userMemories.content,
      importance: userMemories.importance,
      similarity: sql<number>`similarity(${userMemories.content}, ${caption})`,
    })
    .from(userMemories)
    .where(
      and(
        eq(userMemories.userId, userId),
        visibleToSubject(),
        sql`similarity(${userMemories.content}, ${caption}) > ${SIM_THRESHOLD}`
      )
    )
    .orderBy(
      desc(sql`similarity(${userMemories.content}, ${caption})`),
      desc(userMemories.importance)
    )
    .limit(5);
  return rows;
}

/** `read_image` returns the cached vision caption for an image message
 *  the user posted in the current room. The async caption pipeline
 *  (services/memory-worker/jobs/caption-image.ts) writes captions to
 *  `messages.metadata.vision.caption` ~1-3 seconds after upload, so by
 *  the time the agent decides to look the cache is usually warm.
 *
 *  When the caption hasn't landed yet we return a `processing` status
 *  rather than blocking — the agent's prompt instructs it to say "图还
 *  在解析,稍等" in that case. Synchronous vision was the alternative but
 *  the runtime tool timeout is 30s and Kimi K2.6 vision can blow past
 *  that on bigger images, so polling-from-the-agent-side is safer. */
const readImage: ToolHandler = async (args, ctx) => {
  const messageId = typeof args?.messageId === "string" ? args.messageId.trim() : "";
  if (!messageId) return { error: "messageId is required" };

  // Same-room scope: agent can only look at images in the room it's
  // talking in. Prevents a maliciously-crafted prompt from leaking
  // captions for images in other rooms.
  const [msg] = await db
    .select({
      roomId: messages.roomId,
      contentType: messages.contentType,
      content: messages.content,
      metadata: messages.metadata,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.id, messageId));

  if (!msg) return { error: "image not found" };
  if (msg.roomId !== ctx.roomId) return { error: "image is in a different room" };
  if (msg.contentType !== "image") return { error: "message is not an image" };

  const caption = msg.metadata?.vision?.caption?.trim() || "";
  if (caption) {
    // M4.5: anti-"看到不联想". Surface the user's existing memories
    // that share trigram overlap with the caption. Lets the agent
    // realise "this looks like the 布偶猫 they showed me before — that's
    // 邦邦" without having to *decide* to search_memories first.
    const relatedMemories = await findRelatedMemoriesForCaption(
      ctx.userId,
      caption
    );
    log.info(
      {
        messageId,
        captionPreview: caption.slice(0, 60),
        relatedCount: relatedMemories.length,
      },
      "readimage.recall"
    );
    return {
      data: {
        caption,
        model: msg.metadata?.vision?.model,
        generatedAt: msg.metadata?.vision?.generatedAt,
        relatedMemories: relatedMemories.length > 0 ? relatedMemories : undefined,
      },
    };
  }

  // Caption hasn't landed yet. The async job is most likely still
  // running; surface that to the agent so it can defer instead of
  // hallucinating contents.
  log.info(
    { messageId, roomId: ctx.roomId, ageMs: Date.now() - msg.createdAt.getTime() },
    "readimage.caption-pending"
  );
  return {
    data: {
      caption: null,
      status: "processing",
      note: "Image is still being captioned. Tell the user to retry in a moment.",
    },
  };
};

/** Confirm a referenced image is one the agent can call read_image on.
 *  Cheap sanity check — same-room + is-image. Used internally if we
 *  want to validate IDs the model emits before calling the heavier
 *  read_image. Currently unused but harmless to expose. */

export const imageReadToolHandlers: Record<string, ToolHandler> = {
  read_image: readImage,
};

export const imageReadToolDefs = [
  {
    type: "function" as const,
    function: {
      name: "read_image",
      description:
        "Look at an image the user posted in this room. Pass the messageId from the `[图片#N (msgId=...)]` marker that appears inline in the user's message. Returns a text caption of what the image shows. Call this ONLY when the user's message references an image that's relevant to answering — if they're just chatting about something else and an old image is sitting in the recent window, don't bother. Returns `{ caption: null, status: \"processing\" }` if the async caption pipeline hasn't finished yet (~1-3 seconds after upload); in that case tell the user to retry in a moment, don't guess.\n\nThe response ALSO carries `relatedMemories`: user memories the platform thinks relate to this image's caption. Use them when relevant — e.g. if you see a cat photo and `relatedMemories` says the user has a cat called Bangbang, you should refer to the cat by name instead of asking 'whose cat is this?'.",
      parameters: {
        type: "object",
        required: ["messageId"],
        properties: {
          messageId: {
            type: "string",
            description:
              "The messageId from a `[图片#N (msgId=...)]` marker. Must be an image message in this room.",
          },
        },
      },
    },
  },
];
