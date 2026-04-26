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

  const startedAt = Date.now();

  // 1. Provider call
  let img;
  try {
    img = await generateImage(prompt, {
      referenceImages: referenceImageUrls,
    });
  } catch (err: any) {
    log.error(
      {
        err: err?.message,
        userId: ctx.userId,
        roomId: ctx.roomId,
        promptLen: prompt.length,
        refCount: referenceImageUrls.length,
      },
      "imagegen.provider-error"
    );
    return { error: `image-gen failed: ${err?.message || "unknown"}` };
  }

  // 2. Upload to COS so the URL is durable (provider URLs typically expire)
  let upload;
  try {
    upload = await uploadBufferToCos(img.bytes, {
      contentType: img.mimeType,
      keyPrefix: `agent-images/${ctx.roomId}/${agentId}`,
      ext: pickExtension(img.mimeType),
    });
  } catch (err: any) {
    log.error(
      { err: err?.message, userId: ctx.userId, roomId: ctx.roomId },
      "imagegen.upload-error"
    );
    return { error: `upload failed: ${err?.message || "unknown"}` };
  }

  // 3. Persist the image as a regular agent message — same shape as
  // user-uploaded images so existing rendering / history / replies all
  // just work. No separate schema field needed.
  const [row] = await db
    .insert(messages)
    .values({
      roomId: ctx.roomId,
      senderType: "agent",
      senderId: agentId,
      content: upload.url,
      contentType: "image",
      status: "completed",
    })
    .returning();

  // 4. Broadcast so other room members + the originating client see it
  // immediately. The originating client also receives this via Redis
  // pub/sub; ChatPanel's seenIds dedup keeps it from rendering twice.
  publishRoomEvent({
    type: "agent-message",
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

  // The image bubble already renders in the chat. The agent only needs
  // to know it succeeded so its follow-up text reply ("画好了 — ...") is
  // grounded in reality. Keep this payload tiny — full URL is fine
  // because the model occasionally wants to mention "I posted an image
  // for you" but we DON'T want it inlining the URL as markdown.
  return {
    data: {
      url: upload.url,
      provider: "nanobanana",
      modelText: img.modelText || undefined,
    },
  };
};

export const imageToolHandlers: Record<string, ToolHandler> = {
  generate_image: generateImageHandler,
};

export const imageToolDefs = [
  {
    type: "function" as const,
    function: {
      name: "generate_image",
      description:
        "Generate an image from a text prompt (and optional reference images) and post it to the room as a separate image message. Call this whenever the user wants to SEE something — not just literal '画' commands. Concrete triggers: (1) explicit drawing — 画一张 / 画一个 / 画个 / 画下 / 画 X / 来张图 / draw / paint / generate; (2) requests to see — 给我看 / 给我看看 / 给我看一下 X / 让我看看 X / 我想看看 X / 想看 X 的样子 / 看一下 X 长啥样 / show me X / let me see X; (3) implied creation — 'X 长什么样 (with no source to look up)' / '搞张 X 的图' / 'X 的画面'; (4) IMAGE-TO-IMAGE / EDIT — 把这张图改成 X / 用这张图当底 / 改成 X 风格 / 加点 X / 把它变成 X / 这两张融合 / use this image as reference / make it look like X — pass the source image's msgId in referenceMessageIds. The image appears automatically as its own bubble; DO NOT paste the returned URL into your text reply. Just briefly say what you made. One call per request unless user asks for '再来一张' / variations.",
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
];
