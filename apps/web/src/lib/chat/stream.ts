import { db, messages, rooms } from "@agent-platform/db";
import type { ToolInvocation, ToolInvocationHit } from "@agent-platform/db";
import { eq } from "drizzle-orm";
import { pushMemoryJobs } from "@/lib/queue";
import { publishRoomEvent } from "@/lib/redis";
import { publishRoomActivity } from "@/lib/chat/room-activity";
import { createLogger } from "@agent-platform/logger";
import { signToolToken } from "@/lib/tool-token";
import { agentToolDefs } from "@/lib/tools";
import type { LLMMessageContent } from "@/lib/chat/context";

/** Tool names whose results we surface to the user as a "搜索网页" card.
 *  Memory tools (search_memories / remember / etc.) stay invisible because
 *  they're internal bookkeeping the user doesn't care about. */
const VISIBLE_TOOL_NAMES = new Set([
  "web_search",
  "search_lyrics",
  "search_music",
  "fetch_url",
]);

/** Pull a free-form display label out of the JSON-stringified tool args. The
 *  agent's call may stream incrementally so the args string can be partial
 *  garbage by the time we see it — callers must tolerate `undefined`. */
function extractQueryLabel(name: string, argsJson: string): string | undefined {
  if (!argsJson) return undefined;
  try {
    const obj = JSON.parse(argsJson) as Record<string, unknown>;
    if (name === "search_lyrics") {
      const song = typeof obj.song === "string" ? obj.song : "";
      const artist = typeof obj.artist === "string" ? obj.artist : "";
      return artist ? `${song} ${artist}` : song || undefined;
    }
    if (name === "fetch_url") {
      return typeof obj.url === "string" ? obj.url : undefined;
    }
    // web_search / search_music both use `query`.
    return typeof obj.query === "string" ? obj.query : undefined;
  } catch {
    return undefined;
  }
}

/** Shape of the `tool_result.data` payload — matches what
 *  apps/web/src/lib/tools/web-search-tools.ts returns. */
interface ToolResultPayload {
  data?: {
    results?: ToolInvocationHit[];
    provider?: string;
    url?: string;
    title?: string;
    charCount?: number;
  };
  error?: string;
}

function buildInvocation(
  name: string,
  argsJson: string,
  payload: ToolResultPayload | null,
  ok: boolean
): ToolInvocation {
  const inv: ToolInvocation = { name };
  const query = extractQueryLabel(name, argsJson);
  if (query) inv.query = query;

  if (!ok || !payload) {
    inv.error = payload?.error || "tool call failed";
    return inv;
  }

  if (name === "fetch_url") {
    if (payload.data?.url) {
      inv.fetched = {
        url: payload.data.url,
        title: payload.data.title,
        charCount: payload.data.charCount,
      };
    }
    if (payload.data?.provider) inv.provider = payload.data.provider;
    if (payload.error) inv.error = payload.error;
    return inv;
  }

  // web_search / search_lyrics / search_music — list of hits.
  if (Array.isArray(payload.data?.results)) {
    inv.results = payload.data.results.map((r) => ({
      title: r.title || r.url,
      url: r.url,
      snippet: r.snippet,
    }));
  }
  if (payload.data?.provider) inv.provider = payload.data.provider;
  if (payload.error) inv.error = payload.error;
  return inv;
}

const log = createLogger("web");
const AGENT_RUNTIME_URL =
  process.env.AGENT_RUNTIME_URL!;

type ToolChoice =
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

/** Cheap input-classification → tool_choice override. When the user's
 *  message obviously demands a specific tool ("画一张猫" / "学猫叫" /
 *  "唱一段") we force tool_choice to that function, denying the model
 *  the option of writing "(点 🔊 听语音版)" without actually calling
 *  it. Anything that doesn't match falls back to "auto" so the model
 *  still has full freedom for ambiguous cases. Conservative regex —
 *  bias toward NOT forcing on edge cases (Layer 1's post-validation
 *  cleans those up). */
const IMAGE_GEN_TRIGGERS: RegExp[] = [
  /画[一]?[张个幅条只头份片群]/,
  /画.{0,4}[张个幅条只片]/,
  /给我?看看?[一下]?\s*[一-龥]/,
  /让我?看看?[一下]?\s*[一-龥]/,
  /我?想?看看?\s*[一-龥]+(的样子|长什么样)/,
  /搞[一]?张图/,
  /来[一]?张图/,
  /\bdraw\b/i,
  /\bpaint\b/i,
  /\bgenerate\b.*\bimage\b/i,
  /\bshow me a\b/i,
];
const SPEAK_TRIGGERS: RegExp[] = [
  /学.{0,3}叫/,
  /模仿.{0,3}声/,
  /用语音(说|回复|聊|讲)?/,
  /念一下/,
  /朗读/,
  /唱[一]?(段|首|个)?/,
  /哼[一]?(段|首|个)?/,
  /(用|换)[一]?(种|个)?[男女](声音|的声音)?/,
  /\b(sing|hum)\b/i,
  /\bread.*aloud\b/i,
  /\bsay.{0,5}out loud\b/i,
];
function pickToolChoice(userContent: string): ToolChoice {
  if (!userContent) return "auto";
  const c = userContent;
  if (IMAGE_GEN_TRIGGERS.some((r) => r.test(c))) {
    return { type: "function", function: { name: "generate_image" } };
  }
  if (SPEAK_TRIGGERS.some((r) => r.test(c))) {
    return { type: "function", function: { name: "speak" } };
  }
  return "auto";
}
const WEB_BASE_URL =
  process.env.WEB_BASE_URL || "http://localhost:3000";

export type Provider = "deepseek" | "kimi";
export type DeepSeekMode = "flash" | "pro";

/** Call agent-runtime and return a streaming Response */
export async function streamAgentResponse(
  llmMessages: { role: string; content: LLMMessageContent }[],
  agentMsgId: string,
  roomId: string,
  userContent: string,
  userId: string,
  provider: Provider = "deepseek",
  mode: DeepSeekMode = "flash",
  agentName: string = "agent"
): Promise<Response> {
  const toolAuth = await signToolToken({ userId, roomId });
  const toolChoice = pickToolChoice(userContent);
  if (toolChoice !== "auto") {
    log.info(
      { roomId, userId, forcedTool: typeof toolChoice === "object" ? toolChoice.function.name : toolChoice },
      "chat.tool-choice-forced"
    );
  }

  const response = await fetch(`${AGENT_RUNTIME_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: llmMessages,
      tools: agentToolDefs,
      toolCallbackUrl: `${WEB_BASE_URL}/api/agent/tool`,
      toolAuth,
      provider,
      model: mode,
      toolChoice,
    }),
  });

  if (!response.ok || !response.body) {
    log.error({ roomId, agentMsgId, status: response.status }, "stream.runtime-error");
    await db
      .update(messages)
      .set({ status: "failed" })
      .where(eq(messages.id, agentMsgId));
    return new Response("Agent runtime error", { status: 502 });
  }

  const streamStartTime = Date.now();
  let fullContent = "";
  // DeepSeek v4-pro chain-of-thought, captured for the collapsible
  // "thinking" UI block. NOT fed back into the next turn's context.
  let fullReasoning = "";
  let reasoningStartedAt = 0;
  let reasoningEndedAt = 0;
  // Pair tool_call (id, name, args) with the matching tool_result so we can
  // persist the user-visible search hits onto the message. Memory tools are
  // filtered out at persistence time.
  const pendingToolCalls = new Map<string, { name: string; args: string }>();
  const toolInvocations: ToolInvocation[] = [];
  // `speak` tool result → metadata.audio. Captured here so the play
  // button survives reload (the live SSE branch in ChatPanel mirrors
  // this on its own state for immediate feedback).
  let audioPayload: { text: string; voiceId?: string } | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
          const text = decoder.decode(value, { stream: true });
          for (const line of text.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const evt = JSON.parse(data) as {
                content?: string;
                reasoning?: string;
                content_retracted?: boolean;
                tool_call?: { id: string; name: string; args: string };
                tool_result?: {
                  id: string;
                  name?: string;
                  ok: boolean;
                  data?: ToolResultPayload;
                };
              };
              if (evt.reasoning) {
                if (!reasoningStartedAt) reasoningStartedAt = Date.now();
                fullReasoning += evt.reasoning;
              }
              if (evt.content_retracted) {
                // Validator caught a content/tool_call mismatch and is
                // re-running the round. Throw away the partial content
                // we'd been accumulating so the eventual db.update at
                // turn end persists only the corrected reply.
                fullContent = "";
              }
              if (evt.content) {
                if (reasoningStartedAt && !reasoningEndedAt) {
                  reasoningEndedAt = Date.now();
                }
                fullContent += evt.content;
              }
              if (evt.tool_call) {
                pendingToolCalls.set(evt.tool_call.id, {
                  name: evt.tool_call.name,
                  args: evt.tool_call.args,
                });
              }
              if (evt.tool_result) {
                const pending = pendingToolCalls.get(evt.tool_result.id);
                const name = pending?.name || evt.tool_result.name || "";
                const argsJson = pending?.args || "";
                if (name && VISIBLE_TOOL_NAMES.has(name)) {
                  toolInvocations.push(
                    buildInvocation(
                      name,
                      argsJson,
                      (evt.tool_result.data ?? null) as ToolResultPayload | null,
                      !!evt.tool_result.ok
                    )
                  );
                }
                if (name === "speak" && evt.tool_result.ok && argsJson) {
                  try {
                    const parsed = JSON.parse(argsJson) as {
                      text?: unknown;
                      voiceId?: unknown;
                    };
                    if (typeof parsed.text === "string" && parsed.text.trim()) {
                      audioPayload = {
                        text: parsed.text.trim(),
                        ...(typeof parsed.voiceId === "string"
                          ? { voiceId: parsed.voiceId }
                          : {}),
                      };
                    }
                  } catch {}
                }
                pendingToolCalls.delete(evt.tool_result.id);
              }
            } catch {}
          }
        }
      } finally {
        const duration = Date.now() - streamStartTime;
        log.info(
          {
            roomId,
            agentMsgId,
            contentLength: fullContent.length,
            reasoningLength: fullReasoning.length,
            duration,
          },
          "stream.complete"
        );
        log.debug({ roomId, agentMsgId, content: fullContent }, "stream.content");

        const reasoningMs =
          reasoningStartedAt && reasoningEndedAt
            ? reasoningEndedAt - reasoningStartedAt
            : reasoningStartedAt
              ? Date.now() - reasoningStartedAt
              : 0;
        // Only attach a metadata blob when there's a reason to (reasoning
        // trace, tool-result card, or audio button). Plain non-pro /
        // no-tool turns still leave the column NULL.
        const metadata =
          fullReasoning || toolInvocations.length > 0 || audioPayload
            ? {
                ...(fullReasoning ? { reasoning: fullReasoning, reasoningMs } : {}),
                ...(toolInvocations.length > 0 ? { toolInvocations } : {}),
                ...(audioPayload ? { audio: audioPayload } : {}),
              }
            : undefined;

        await db
          .update(messages)
          .set({
            content: fullContent,
            status: "completed",
            metadata,
            updatedAt: new Date(),
          })
          .where(eq(messages.id, agentMsgId));

        // Broadcast completed agent message to room
        log.info({ roomId, eventType: "agent-message", agentMsgId }, "stream.publish");
        publishRoomEvent({
          type: "agent-message",
          roomId,
          triggeredBy: userId,
          message: {
            id: agentMsgId,
            senderType: "agent",
            senderId: null,
            senderName: agentName,
            content: fullContent,
            status: "completed",
          },
        });

        // Bubble this room to the top of every member's sidebar.
        publishRoomActivity(roomId);

        // Auto-generate room title (fire and forget)
        maybeGenerateRoomTitle(roomId, userContent, fullContent);

        // Push memory extraction jobs (async, non-blocking)
        pushMemoryJobs(roomId, userId).catch(() => {});

        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/** Generate room title from first conversation */
async function maybeGenerateRoomTitle(
  roomId: string,
  userContent: string,
  agentContent: string
) {
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
  if (!room || room.name !== "New Chat") return;

  try {
    const res = await fetch(`${AGENT_RUNTIME_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content:
              "Generate a short title (under 20 characters) for this conversation. Reply with only the title, nothing else.",
          },
          { role: "user", content: userContent },
          { role: "assistant", content: agentContent },
        ],
      }),
    });

    if (!res.ok || !res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let title = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        try {
          const { content } = JSON.parse(data);
          if (content) title += content;
        } catch {}
      }
    }

    title = title.trim().replace(/^["']|["']$/g, "");
    if (title) {
      await db
        .update(rooms)
        .set({ name: title, updatedAt: new Date() })
        .where(eq(rooms.id, roomId));
    }
  } catch {}
}
