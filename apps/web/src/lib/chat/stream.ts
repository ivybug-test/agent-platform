import { db, messages, rooms } from "@agent-platform/db";
import { eq } from "drizzle-orm";
import { pushMemoryJobs } from "@/lib/queue";
import { publishRoomEvent } from "@/lib/redis";
import { createLogger } from "@agent-platform/logger";
import { signToolToken } from "@/lib/tool-token";
import { agentToolDefs } from "@/lib/tools";

const log = createLogger("web");
const AGENT_RUNTIME_URL =
  process.env.AGENT_RUNTIME_URL!;
const WEB_BASE_URL =
  process.env.WEB_BASE_URL || "http://localhost:3000";

/** Call agent-runtime and return a streaming Response */
export async function streamAgentResponse(
  llmMessages: { role: string; content: string }[],
  agentMsgId: string,
  roomId: string,
  userContent: string,
  userId: string
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
              const { content: chunk } = JSON.parse(data);
              if (chunk) fullContent += chunk;
            } catch {}
          }
        }
      } finally {
        const duration = Date.now() - streamStartTime;
        log.info({ roomId, agentMsgId, contentLength: fullContent.length, duration }, "stream.complete");
        log.debug({ roomId, agentMsgId, content: fullContent }, "stream.content");

        await db
          .update(messages)
          .set({
            content: fullContent,
            status: "completed",
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
            senderName: "Agent",
            content: fullContent,
            status: "completed",
          },
        });

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
