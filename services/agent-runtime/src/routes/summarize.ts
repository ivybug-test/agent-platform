import type { FastifyInstance } from "fastify";
import { chatConfig } from "../llm.js";
import type { SummarizeBody } from "../types.js";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("agent-runtime");

export function registerSummarizeRoute(app: FastifyInstance, isMock: boolean) {
  // Non-streaming completion used for ad-hoc summaries (release notes etc).
  app.post<{ Body: SummarizeBody }>("/summarize", async (request, reply) => {
    const { system, user, temperature = 0.3 } = request.body;
    if (isMock) {
      return { text: "(mock mode — no real summary)" };
    }
    try {
      // /summarize is DeepSeek-only by design (ad-hoc text summaries —
      // never multimodal). Honours the caller's temperature override.
      const cfg = chatConfig("deepseek");
      const res = await cfg.client.chat.completions.create({
        model: cfg.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature,
      });
      return { text: res.choices[0]?.message?.content || "" };
    } catch (err) {
      log.error({ err }, "summarize.error");
      reply.code(502);
      return { error: "summarize failed" };
    }
  });
}
