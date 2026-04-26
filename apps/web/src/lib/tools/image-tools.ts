import { db, messages, roomMembers, agents } from "@agent-platform/db";
import { and, eq, inArray } from "drizzle-orm";
import { generateImage } from "@/lib/image-gen";
import { uploadBufferToCos } from "@/lib/cos/server-upload";
import { publishRoomEvent, getRedisClient } from "@/lib/redis";
import { createLogger } from "@agent-platform/logger";
import type { ToolHandler } from "./index";

const log = createLogger("web");

// Image generation is expensive (model call + COS upload + DB write +
// Redis broadcast). Hold the per-user rate tighter than web search.
const RATE_PER_MIN = 5;
const RATE_PER_DAY = 50;

// Per-message AbortController for in-flight generations so the
// `cancel_image_generation` tool can interrupt mid-flight. Keyed by
// the placeholder message id. Lives in this Next.js process; survives
// neither restart nor multiple replicas — acceptable for now since
// dev / single-replica prod is the only deployment shape and a 20-30s
// stale entry is harmless.
const inFlightImageGens = new Map<string, AbortController>();

async function checkRateLimit(userId: string): Promise<{
  ok: boolean;
  retryAfterSec?: number;
}> {
  try {
    const redis = getRedisClient();
    const minute = Math.floor(Date.now() / 60000);
    const day = Math.floor(Date.now() / 86400000);
    const minKey = `imagegen:min:${userId}:${minute}`;
    const dayKey = `imagegen:day:${userId}:${day}`;
    const [minCount, dayCount] = await Promise.all([
      redis.incr(minKey),
      redis.incr(dayKey),
    ]);
    if (minCount === 1) await redis.expire(minKey, 65);
    if (dayCount === 1) await redis.expire(dayKey, 86400);
    if (minCount > RATE_PER_MIN) return { ok: false, retryAfterSec: 60 };
    if (dayCount > RATE_PER_DAY) return { ok: false, retryAfterSec: 86400 };
    return { ok: true };
  } catch (err) {
    log.warn({ err }, "imagegen.ratelimit-redis-error");
    return { ok: true };
  }
}

function pickExtension(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  return "png";
}

const MAX_REFERENCE_IMAGES = 4;

const generateImageHandler: ToolHandler = async (args, ctx) => {
  const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) return { error: "prompt is required" };
  if (prompt.length > 1000) return { error: "prompt too long (max 1000 chars)" };

  // Optional image-to-image / multi-reference inputs. Agent passes
  // msgIds of image messages from the recent window (lifted from the
  // [图片#N (msgId=...)] inline markers); we resolve them to COS URLs
  // server-side, both to enforce same-room scope and to avoid trusting
  // arbitrary URLs from the model.
  const rawIds = Array.isArray(args?.referenceMessageIds)
    ? (args.referenceMessageIds as unknown[]).filter(
        (x): x is string => typeof x === "string" && x.trim().length > 0
      )
    : [];
  if (rawIds.length > MAX_REFERENCE_IMAGES) {
    return {
      error: `too many reference images (max ${MAX_REFERENCE_IMAGES})`,
    };
  }
  let referenceImageUrls: string[] = [];
  if (rawIds.length > 0) {
    const refRows = await db
      .select({
        id: messages.id,
        roomId: messages.roomId,
        contentType: messages.contentType,
        content: messages.content,
      })
      .from(messages)
      .where(inArray(messages.id, rawIds));
    const byId = new Map(refRows.map((r) => [r.id, r]));
    for (const id of rawIds) {
      const r = byId.get(id);
      if (!r) return { error: `reference image not found: ${id}` };
      if (r.roomId !== ctx.roomId) {
        return { error: `reference image is in a different room: ${id}` };
      }
      if (r.contentType !== "image" || !r.content) {
        return { error: `not an image message: ${id}` };
      }
      referenceImageUrls.push(r.content);
    }
  }

  const rate = await checkRateLimit(ctx.userId);
  if (!rate.ok) {
    return { error: "image-gen rate limit", retryAfterSec: rate.retryAfterSec };
  }

  // Resolve the agent that owns this room (Phase 1: single agent per
  // room, schema supports multi). The image message gets posted under
  // that agent's identity so it renders identically to a normal text
  // reply from the same agent.
  const [agentMember] = await db
    .select({ memberId: roomMembers.memberId })
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.roomId, ctx.roomId),
        eq(roomMembers.memberType, "agent")
      )
    );
  if (!agentMember) return { error: "no agent in this room" };
  const agentId = agentMember.memberId;
  const [agentRow] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId));
  const agentName = agentRow?.name || "agent";

  // 1. Insert a placeholder image message synchronously. contentType
  // "image-pending" tells the frontend to render a spinner / "生成中"
  // instead of a real <img>. Status stays "streaming" until either
  // the BG promise updates it to completed (with a real URL) or it's
  // cancelled / fails.
  const [row] = await db
    .insert(messages)
    .values({
      roomId: ctx.roomId,
      senderType: "agent",
      senderId: agentId,
      content: "",
      contentType: "image-pending",
      status: "streaming",
    })
    .returning();

  // 2. Broadcast the placeholder so other room members see "生成中..."
  // even while we're still cooking. Originating client also picks it
  // up off the SSE tool_result return below — Redis isn't on the
  // critical path for them.
  publishRoomEvent({
    type: "agent-message",
    roomId: ctx.roomId,
    triggeredBy: ctx.userId,
    message: {
      id: row.id,
      senderType: "agent",
      senderId: agentId,
      senderName: agentName,
      content: "",
      contentType: "image-pending",
      status: "streaming",
    },
  });

  // 3. Kick off the actual gen + upload + DB-update + completion-
  // broadcast off-thread. The Next.js process keeps running so the
  // promise completes; we don't need BullMQ for a single ~20s job.
  // AbortController lets cancel_image_generation interrupt it.
  const ac = new AbortController();
  inFlightImageGens.set(row.id, ac);
  const startedAt = Date.now();

  void (async () => {
    try {
      const img = await generateImage(prompt, {
        referenceImages: referenceImageUrls,
        signal: ac.signal,
      });
      if (ac.signal.aborted) throw new DOMException("aborted", "AbortError");
      const upload = await uploadBufferToCos(img.bytes, {
        contentType: img.mimeType,
        keyPrefix: `agent-images/${ctx.roomId}/${agentId}`,
        ext: pickExtension(img.mimeType),
      });
      if (ac.signal.aborted) throw new DOMException("aborted", "AbortError");

      await db
        .update(messages)
        .set({
          content: upload.url,
          contentType: "image",
          status: "completed",
          updatedAt: new Date(),
        })
        .where(eq(messages.id, row.id));

      publishRoomEvent({
        type: "message-updated",
        roomId: ctx.roomId,
        triggeredBy: ctx.userId,
        message: {
          id: row.id,
          senderType: "agent",
          senderId: agentId,
          senderName: agentName,
          content: upload.url,
          contentType: "image",
          status: "completed",
        },
      });

      log.info(
        {
          userId: ctx.userId,
          roomId: ctx.roomId,
          agentId,
          messageId: row.id,
          bytes: img.bytes.length,
          durationMs: Date.now() - startedAt,
          promptLen: prompt.length,
        },
        "imagegen.complete"
      );
    } catch (err: any) {
      const aborted =
        err?.name === "AbortError" || ac.signal.aborted;
      log.warn(
        {
          err: err?.message,
          userId: ctx.userId,
          roomId: ctx.roomId,
          messageId: row.id,
          aborted,
        },
        aborted ? "imagegen.cancelled" : "imagegen.bg-failed"
      );
      // Mark the placeholder as failed so the bubble stops spinning
      // and the user knows it didn't land. Cancel and provider error
      // share this path — the contentType signals "this was an image
      // attempt that didn't finish" to the frontend.
      await db
        .update(messages)
        .set({
          content: aborted ? "(已取消)" : `(生成失败: ${err?.message || "unknown"})`.slice(0, 200),
          contentType: "image-failed",
          status: "failed",
          updatedAt: new Date(),
        })
        .where(eq(messages.id, row.id))
        .catch(() => {});
      publishRoomEvent({
        type: "message-updated",
        roomId: ctx.roomId,
        triggeredBy: ctx.userId,
        message: {
          id: row.id,
          senderType: "agent",
          senderId: agentId,
          senderName: agentName,
          content: aborted ? "(已取消)" : `(生成失败: ${err?.message || "unknown"})`.slice(0, 200),
          contentType: "image-failed",
          status: "failed",
        },
      });
    } finally {
      inFlightImageGens.delete(row.id);
    }
  })();

  // 4. Return immediately so the agent's tool callback unblocks. The
  // tool result tells the frontend the messageId of the placeholder
  // so it can render the spinner bubble; once the BG promise lands
  // a message-updated event, the bubble swaps to the real image.
  return {
    data: {
      messageId: row.id,
      queued: true,
      provider: "nanobanana",
    },
  };
};

/** Abort an in-flight generate_image call. Looks up the
 *  AbortController stashed by generateImageHandler when it kicked off
 *  the BG promise, signals it, lets the existing catch path mark the
 *  message as cancelled. */
const cancelImageGenerationHandler: ToolHandler = async (args, ctx) => {
  const messageId =
    typeof args?.messageId === "string" ? args.messageId.trim() : "";
  if (!messageId) return { error: "messageId is required" };

  const ac = inFlightImageGens.get(messageId);
  if (!ac) {
    // Either gen already finished (placeholder swapped to image-completed)
    // or the messageId is bogus. Either way nothing to cancel.
    return {
      data: {
        ok: false,
        reason:
          "no in-flight generation for that messageId (already finished, failed, or never existed)",
      },
    };
  }
  // Verify same-room scope so a malicious-prompt scenario can't poke
  // generations in other rooms.
  const [row] = await db
    .select({ roomId: messages.roomId })
    .from(messages)
    .where(eq(messages.id, messageId));
  if (!row || row.roomId !== ctx.roomId) {
    return { error: "messageId is not in this room" };
  }
  ac.abort();
  log.info(
    { userId: ctx.userId, roomId: ctx.roomId, messageId },
    "imagegen.cancel-requested"
  );
  return { data: { ok: true } };
};

export const imageToolHandlers: Record<string, ToolHandler> = {
  generate_image: generateImageHandler,
  cancel_image_generation: cancelImageGenerationHandler,
};

export const imageToolDefs = [
  {
    type: "function" as const,
    function: {
      name: "generate_image",
      description:
        "Generate an image from a text prompt (+ optional reference images). The tool is ASYNC — it returns immediately with { messageId, queued: true } and the actual gen runs in the background (~20s). The placeholder image message is already in the room as a 'generating...' bubble. When the BG task lands, it swaps in the real image automatically. So your text reply should be quick acknowledgment ('画着呢，稍等一下~' / '我开始画了'), NOT 'here it is' phrasing. Triggers: (1) explicit drawing — 画一张 / 画一个 / 画个 / 画下 / 画 X / 来张图 / draw / paint / generate; (2) requests to see — 给我看 / 给我看看 / 让我看看 / 我想看看 / 看一下 X 长啥样 / show me X / let me see X; (3) implied creation — 'X 长什么样 / 搞张 X 的图 / X 的画面'; (4) IMAGE-TO-IMAGE / EDIT — 把这张图改成 X / 改成 X 风格 / 加点 X / 这两张融合 — pass the source image's msgId in referenceMessageIds. ALSO remember the returned messageId — if the user later says '停 / 别画了 / 取消', call cancel_image_generation({messageId}) with it. DO NOT paste the URL in your reply. One generate_image call per request.",
      parameters: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: {
            type: "string",
            description:
              "Concrete English or Chinese description of the desired image: subject, action, style, mood. Avoid bracketed instructions, markdown, or 'a beautiful image of'. For image-to-image / edit, describe what to CHANGE or ADD relative to the reference (e.g. '把背景换成赛博朋克霓虹街道,主角不变'). Cap 1000 chars.",
          },
          referenceMessageIds: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional msgIds of image messages in this room to use as visual references for image-to-image generation. Read these from the inline '[图片#N (msgId=xxx)]' markers above. Pass when the user asks to MODIFY an existing image (改 / 加 / 变成 / 用这张), apply a STYLE to it, or FUSE multiple images. 1-4 ids supported; each must be an image message in the SAME room. Omit for plain text-to-image.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "cancel_image_generation",
      description:
        "Cancel an in-flight generate_image call you started earlier in this conversation. Use when the user explicitly asks to stop / cancel / abort the drawing — '停 / 别画了 / 取消 / stop / cancel / 不要了'. Pass the messageId you got back from the generate_image tool result. Returns { ok: true } when the BG task was successfully signalled to abort, or { ok: false, reason } if the gen has already finished / failed / wasn't found. Don't call this preemptively — only when the user says to stop.",
      parameters: {
        type: "object",
        required: ["messageId"],
        properties: {
          messageId: {
            type: "string",
            description:
              "The messageId returned from a recent generate_image tool call (the placeholder image bubble's id).",
          },
        },
      },
    },
  },
];
