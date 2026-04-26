import { db, messages, rooms } from "@agent-platform/db";
import { eq } from "drizzle-orm";
import { pushMemoryJobs } from "@/lib/queue";
import { publishRoomEvent } from "@/lib/redis";
import { publishRoomActivity } from "@/lib/chat/room-activity";
import { createLogger } from "@agent-platform/logger";
import { signToolToken } from "@/lib/tool-token";
import { agentToolDefs } from "@/lib/tools";
import type { LLMMessageContent } from "@/lib/chat/context";

const log = createLogger("web");
const AGENT_RUNTIME_URL =
  process.env.AGENT_RUNTIME_URL!;
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
              };
              if (evt.reasoning) {
                if (!reasoningStartedAt) reasoningStartedAt = Date.now();
                fullReasoning += evt.reasoning;
              }
              if (evt.content) {
                if (reasoningStartedAt && !reasoningEndedAt) {
                  reasoningEndedAt = Date.now();
                }
                fullContent += evt.content;
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
        // Only attach a metadata blob when there's actually reasoning to
        // store; non-pro turns leave the column NULL.
        const metadata = fullReasoning
          ? { reasoning: fullReasoning, reasoningMs }
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
