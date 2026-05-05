import type { FastifyInstance } from "fastify";
import { getModel } from "../../llm.js";
import {
  DEFAULT_MAX_TOOL_ROUNDS,
  HARD_TOOL_ROUND_CAP,
} from "../../constants.js";
import type { ChatBody } from "../../types.js";
import { runFastPath } from "./fast-path.js";
import { runToolLoop } from "./tool-loop.js";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("agent-runtime");

export function registerChatRoute(app: FastifyInstance, isMock: boolean) {
  app.post<{ Body: ChatBody }>("/chat", async (request, reply) => {
    const {
      messages: initialMessages,
      tools,
      toolCallbackUrl,
      toolAuth,
      maxToolRounds,
      provider = "deepseek",
      model: mode = "flash",
      toolChoice: requestedToolChoice,
    } = request.body;
    const startTime = Date.now();
    const toolsEnabled = Array.isArray(tools) && tools.length > 0;
    const maxRounds = Math.min(
      maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
      HARD_TOOL_ROUND_CAP
    );

    log.info(
      {
        messageCount: initialMessages.length,
        provider,
        mode,
        model: getModel(provider, mode),
        toolsEnabled,
        toolCount: tools?.length ?? 0,
        mock: isMock,
      },
      "llm.request"
    );

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const sendEvent = (obj: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    if (!toolsEnabled) {
      await runFastPath({
        initialMessages,
        provider,
        mode,
        isMock,
        startTime,
        sendEvent,
      });
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return;
    }

    if (!toolCallbackUrl || !toolAuth) {
      sendEvent({ error: "tools require toolCallbackUrl and toolAuth" });
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return;
    }

    await runToolLoop({
      initialMessages,
      tools: tools!,
      toolCallbackUrl,
      toolAuth,
      maxRounds,
      provider,
      mode,
      requestedToolChoice,
      isMock,
      startTime,
      sendEvent,
    });

    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
  });
}
