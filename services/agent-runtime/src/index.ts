import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), "../../.env") });

import Fastify from "fastify";
import {
  chatConfig,
  getModel,
  type Provider,
  type DeepSeekMode,
} from "./llm.js";
import { mockStream, mockToolStream, mockVisionStream } from "./mock.js";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("agent-runtime");

const app = Fastify({ logger: true });
const isMock = process.env.MOCK_LLM === "true";

app.get("/health", async () => ({ status: "ok" }));

interface SummarizeBody {
  system: string;
  user: string;
  temperature?: number;
}

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

interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatBody {
  messages: any[];
  tools?: ToolDef[];
  toolCallbackUrl?: string;
  toolAuth?: string;
  maxToolRounds?: number;
  provider?: Provider;
  /** DeepSeek-only knob: flash (fast/cheap) or pro (reasoning).
   *  Ignored when provider="kimi" (vision model is fixed). */
  model?: DeepSeekMode;
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  args: string;
}

const TOOL_CALL_TIMEOUT_MS = 15000;
const DEFAULT_MAX_TOOL_ROUNDS = 5;
const HARD_TOOL_ROUND_CAP = 10;

app.post<{ Body: ChatBody }>("/chat", async (request, reply) => {
  const {
    messages: initialMessages,
    tools,
    toolCallbackUrl,
    toolAuth,
    maxToolRounds,
    provider = "deepseek",
    model: mode = "flash",
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

  // Fast path: legacy non-tool behavior preserved for simple chat calls
  if (!toolsEnabled) {
    let totalChars = 0;
    try {
      if (isMock) {
        const mockIter = provider === "kimi" ? mockVisionStream() : mockStream();
        for await (const chunk of mockIter) {
          sendEvent({ content: chunk });
          totalChars += chunk.length;
        }
      } else {
        const cfg = chatConfig(provider, mode, { withPenalties: true });
        const stream = await cfg.client.chat.completions.create({
          model: cfg.model,
          messages: initialMessages,
          stream: true,
          ...cfg.sampling,
        });
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta as
            | { content?: string | null; reasoning_content?: string | null }
            | undefined;
          // DeepSeek v4-pro streams its chain-of-thought as
          // `reasoning_content` (separate from `content`). Forward it as a
          // distinct SSE event so the frontend can show a collapsed
          // "thinking" panel above the actual reply.
          if (delta?.reasoning_content) {
            sendEvent({ reasoning: delta.reasoning_content });
          }
          if (delta?.content) {
            sendEvent({ content: delta.content });
            totalChars += delta.content.length;
          }
        }
      }
      log.info({ duration: Date.now() - startTime, totalChars }, "llm.complete");
    } catch (err) {
      log.error({ err, duration: Date.now() - startTime }, "llm.error");
      sendEvent({ error: "llm error" });
    }
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
    return;
  }

  // Tool-calling loop
  if (!toolCallbackUrl || !toolAuth) {
    sendEvent({ error: "tools require toolCallbackUrl and toolAuth" });
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
    return;
  }

  const messages: any[] = [...initialMessages];
  let totalChars = 0;
  let round = 0;
  let done = false;

  try {
    while (!done && round < maxRounds) {
      const accumulated: Record<number, AccumulatedToolCall> = {};
      let finishReason: string | null = null;
      let assistantText = "";

      const iter: AsyncIterable<any> = await (async () => {
        if (isMock) {
          return mockToolStream(
            round,
            (tools as ToolDef[]).map((t) => t.function.name)
          );
        }
        const cfg = chatConfig(provider, mode);
        return (await cfg.client.chat.completions.create({
          model: cfg.model,
          messages,
          tools: tools as any,
          tool_choice: "auto",
          stream: true,
          ...cfg.sampling,
        })) as any;
      })();

      for await (const chunk of iter) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.reasoning_content) {
          sendEvent({ reasoning: delta.reasoning_content });
        }
        if (delta.content) {
          assistantText += delta.content;
          totalChars += delta.content.length;
          sendEvent({ content: delta.content });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!accumulated[idx]) {
              accumulated[idx] = { id: "", name: "", args: "" };
            }
            if (tc.id) accumulated[idx].id = tc.id;
            if (tc.function?.name) {
              accumulated[idx].name += tc.function.name;
            }
            if (tc.function?.arguments) {
              accumulated[idx].args += tc.function.arguments;
            }
          }
        }
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }

      if (finishReason !== "tool_calls") {
        done = true;
        break;
      }

      const toolCallList = Object.keys(accumulated)
        .map((k) => Number(k))
        .sort((a, b) => a - b)
        .map((k) => accumulated[k]);

      if (toolCallList.length === 0) {
        // Model said tool_calls but emitted none — defensive bail-out
        done = true;
        break;
      }

      // Record the assistant turn with its tool_calls so the next round has context
      messages.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: toolCallList.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.args },
        })),
      });

      // Execute each tool call via the Next.js callback, in series
      for (const tc of toolCallList) {
        sendEvent({
          tool_call: { id: tc.id, name: tc.name, args: tc.args },
        });
        let toolResultContent = "";
        let ok = false;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), TOOL_CALL_TIMEOUT_MS);
        try {
          const res = await fetch(toolCallbackUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${toolAuth}`,
            },
            body: JSON.stringify({
              tool: tc.name,
              arguments: tc.args,
            }),
            signal: ac.signal,
          });
          const text = await res.text();
          ok = res.ok;
          toolResultContent = text || JSON.stringify({ ok });
          log.info(
            { round, tool: tc.name, status: res.status, bytes: text.length },
            "tool.result"
          );
        } catch (err: any) {
          toolResultContent = JSON.stringify({
            error: err?.message || "tool call failed",
          });
          log.error({ round, tool: tc.name, err }, "tool.error");
        } finally {
          clearTimeout(timer);
        }
        sendEvent({ tool_result: { id: tc.id, ok } });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: toolResultContent,
        });
      }

      round++;
    }

    if (!done) {
      log.warn({ rounds: round }, "tool.max-rounds-hit");
      sendEvent({ error: "max tool rounds reached" });
    }

    log.info(
      { duration: Date.now() - startTime, totalChars, rounds: round },
      "llm.complete"
    );
  } catch (err) {
    log.error({ err, round, duration: Date.now() - startTime }, "llm.error");
    sendEvent({ error: "llm error" });
  }

  reply.raw.write("data: [DONE]\n\n");
  reply.raw.end();
});

const start = async () => {
  const port = Number(process.env.PORT) || 3001;
  await app.listen({ port, host: "0.0.0.0" });
  const model = getModel();
  app.log.info(
    `LLM: ${isMock ? "MOCK" : `${model} via ${process.env.LLM_BASE_URL || "openai"}`}`
  );
};

start();
