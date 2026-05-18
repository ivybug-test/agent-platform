import { db, messages, roomMembers, userMemories } from "@agent-platform/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { createLogger } from "@agent-platform/logger";
import { visibleToSubject } from "@/lib/memory-filters";
import type { ToolHandler } from "./index";

const log = createLogger("web");

/** M4.5/M5 — look up user memories that semantically relate to an image
 *  caption. The cure for "看到不联想":the model sees a cat photo, gets
 *  caption "一只布偶猫", and should automatically recall that the user
 *  has a布偶猫 named 邦邦 — without having to *decide* to search memory.
 *
 *  M5 (preferred): cosine over `messages.embedding` (already populated by
 *  caption-image.ts on caption write) ⨯ `user_memories.embedding`. Catches
 *  paraphrase: "蛋糕" ↔ "甜食", "布偶" ↔ "猫". Threshold 0.30 cosine
 *  similarity (= 0.70 distance) — tuned to be friendly to short captions.
 *
 *  M4.5 fallback: pg_trgm similarity against user_memories.content for
 *  rows that still have NULL embedding (older images pre-M5 or transient
 *  embed failures). Trgm result is union-merged with cosine, deduped by
 *  memory id. Low threshold (0.05) because Chinese trigram overlap is
 *  sparse. Top 5 overall by similarity score. */
async function findRelatedMemoriesForCaption(
  userId: string,
  caption: string,
  captionEmbedding: number[] | null
): Promise<{ id: string; content: string; importance: string; similarity: number }[]> {
  if (!caption || caption.length < 3) return [];

  const COSINE_DISTANCE_MAX = 0.70; // → similarity >= 0.30
  const TRGM_THRESHOLD = 0.05;
  const TOP_N = 5;

  // pgvector literal: drizzle handles vector params for inserts but the
  // distance operator needs a literal cast.
  const captionVec = captionEmbedding
    ? `[${captionEmbedding.join(",")}]`
    : null;

  // Cosine branch — only if we have a caption embedding AND the memory
  // row has an embedding. Distance smaller = more similar.
  const cosineRows = captionVec
    ? await db
        .select({
          id: userMemories.id,
          content: userMemories.content,
          importance: userMemories.importance,
          similarity: sql<number>`1 - (${userMemories.embedding} <=> ${captionVec}::vector)`,
        })
        .from(userMemories)
        .where(
          and(
            eq(userMemories.userId, userId),
            visibleToSubject(),
            sql`${userMemories.embedding} IS NOT NULL`,
            sql`(${userMemories.embedding} <=> ${captionVec}::vector) < ${COSINE_DISTANCE_MAX}`
          )
        )
        .orderBy(sql`${userMemories.embedding} <=> ${captionVec}::vector`)
        .limit(TOP_N)
    : [];

  // Trgm branch — covers user_memories rows whose embedding is still NULL.
  // Excluding rows that have an embedding avoids double-counting; once
  // backfill is complete this branch effectively becomes empty.
  const trgmRows = await db
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
        sql`${userMemories.embedding} IS NULL`,
        sql`similarity(${userMemories.content}, ${caption}) > ${TRGM_THRESHOLD}`
      )
    )
    .orderBy(
      desc(sql`similarity(${userMemories.content}, ${caption})`),
      desc(userMemories.importance)
    )
    .limit(TOP_N);

  // Union, dedupe by id (cosine wins on tie since we put it first), top N.
  const seen = new Set<string>();
  const merged: { id: string; content: string; importance: string; similarity: number }[] = [];
  for (const r of [...cosineRows, ...trgmRows]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  merged.sort((a, b) => b.similarity - a.similarity);
  return merged.slice(0, TOP_N);
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
      embedding: messages.embedding,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.id, messageId));

  if (!msg) return { error: "image not found" };
  if (msg.roomId !== ctx.roomId) return { error: "image is in a different room" };
  if (msg.contentType !== "image") return { error: "message is not an image" };

  const caption = msg.metadata?.vision?.caption?.trim() || "";
  if (caption) {
    // M4.5/M5: anti-"看到不联想". Surface user memories that semantically
    // relate to this image. M5 prefers cosine over the pre-computed
    // caption embedding (messages.embedding); M4.5 trgm covers memory rows
    // not yet embedded.
    const relatedMemories = await findRelatedMemoriesForCaption(
      ctx.userId,
      caption,
      msg.embedding ?? null
    );
    log.info(
      {
        messageId,
        captionPreview: caption.slice(0, 60),
        relatedCount: relatedMemories.length,
        path: msg.embedding ? "cosine+trgm" : "trgm-only",
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
