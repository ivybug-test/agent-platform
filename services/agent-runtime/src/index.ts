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

type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

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
  /** Optional override for first-round tool_choice. Web side picks
   *  this from the user's input via cheap regex (画一张 → force
   *  generate_image, 学猫叫 → force speak, etc) so the model can't
   *  hallucinate "I called the tool" without actually calling. Defaults
   *  to "auto" when absent. */
  toolChoice?: ToolChoice;
}

/** Patterns the model loves to write WHEN IT THINKS the tool fired,
 *  even if it didn't. If we see one of these in the assistant text
 *  AND the matching tool wasn't actually called this turn, the
 *  model hallucinated and we re-prompt with forced tool_choice. */
function detectHallucinatedTool(
  text: string,
  toolsCalled: Set<string>
): string | null {
  if (!text) return null;
  if (
    /🔊|听语音版|语音版|\(点.{0,4}听\)|语音已发/.test(text) &&
    !toolsCalled.has("speak")
  ) {
    return "speak";
  }
  if (
    /画着呢|稍等十几秒|稍等几秒|马上.{0,3}来|马上就好|正在画|开始画|画好了|看这张|图给你|图已生成/.test(
      text
    ) &&
    !toolsCalled.has("generate_image")
  ) {
    return "generate_image";
  }
  return null;
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  args: string;
}

// 30s. Web search tool chains do Bocha → optional Tavily fallback, plus
// remote provider RTT — cumulative slow case can comfortably exceed 15s
// on a CN box hitting Tavily. Hitting the timeout is the most common
// way users see a generic "tool call failed" with no detail.
const TOOL_CALL_TIMEOUT_MS = 30000;
const DEFAULT_MAX_TOOL_ROUNDS = 5;
const HARD_TOOL_ROUND_CAP = 10;
// Cap the final answer at 4096 tokens. DeepSeek's `max_tokens` only
// counts visible output (chain-of-thought has its own internal budget),
// so this just guards against runaway answers — it does NOT shrink the
// reasoning window.
const CHAT_MAX_TOKENS = 4096;

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

  // Fast path: legacy non-tool behavior preserved for simple chat calls
  if (!toolsEnabled) {
    let totalChars = 0;
    let hasContent = false;
    let hasReasoning = false;
    let finishReason: string | null = null;
    try {
      if (isMock) {
        const mockIter = provider === "kimi" ? mockVisionStream() : mockStream();
        for await (const chunk of mockIter) {
          sendEvent({ content: chunk });
          totalChars += chunk.length;
          hasContent = true;
        }
      } else {
        const cfg = chatConfig(provider, mode, { withPenalties: true });
        const stream = await cfg.client.chat.completions.create({
          model: cfg.model,
          messages: initialMessages,
          stream: true,
          max_tokens: CHAT_MAX_TOKENS,
          ...cfg.sampling,
        });
        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];
          const delta = choice?.delta as
            | { content?: string | null; reasoning_content?: string | null }
            | undefined;
          // DeepSeek v4-pro streams its chain-of-thought as
          // `reasoning_content` (separate from `content`). Only surface
          // it to the client in pro mode; flash users opted out of the
          // "thinking" UI entirely.
          if (delta?.reasoning_content) {
            hasReasoning = true;
            if (mode === "pro") {
              sendEvent({ reasoning: delta.reasoning_content });
            }
          }
          if (delta?.content) {
            sendEvent({ content: delta.content });
            totalChars += delta.content.length;
            hasContent = true;
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
        }
      }

      // Fallback: if reasoning happened but no content was emitted (pro
      // model burned its budget on the chain-of-thought, or the upstream
      // dropped the answer), re-run the same prompt in flash so the user
      // never gets a "thought-but-didn't-answer" turn.
      if (!isMock && !hasContent && hasReasoning) {
        log.warn(
          { finishReason, mode },
          "llm.empty-content-after-reasoning, falling back to flash"
        );
        const fb = chatConfig(provider, "flash", { withPenalties: true });
        const fbStream = await fb.client.chat.completions.create({
          model: fb.model,
          messages: initialMessages,
          stream: true,
          max_tokens: CHAT_MAX_TOKENS,
          ...fb.sampling,
        });
        for await (const chunk of fbStream) {
          const c = chunk.choices?.[0]?.delta?.content;
          if (c) {
            sendEvent({ content: c });
            totalChars += c.length;
            hasContent = true;
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

  // Track tools the agent ACTUALLY emitted across all rounds this
  // turn — the validator uses this to spot "I claimed a tool ran
  // but no tool_call exists" hallucinations. Retries are capped so
  // a stubborn model can't spin the loop forever.
  const toolsCalledThisTurn = new Set<string>();
  let retriesLeft = 1;
  // Set when the validator wants the next round to FORCE a specific
  // tool_choice. Cleared after one use so it doesn't leak past retry.
  let forceToolChoice: ToolChoice | null = null;

  try {
    while (!done && round < maxRounds) {
      const accumulated: Record<number, AccumulatedToolCall> = {};
      let finishReason: string | null = null;
      let assistantText = "";

      // Pick this round's tool_choice. Order of preference:
      //   1. Validator-forced override (after a hallucination retry)
      //   2. Per-request override (招1 — web layer's regex routing)
      //   3. "auto" default
      const roundToolChoice: ToolChoice =
        forceToolChoice ?? requestedToolChoice ?? "auto";
      forceToolChoice = null;

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
          tool_choice: roundToolChoice,
          stream: true,
          max_tokens: CHAT_MAX_TOKENS,
          ...cfg.sampling,
        })) as any;
      })();

      let roundHadReasoning = false;
      // Accumulated reasoning_content for the round. DeepSeek now requires
      // the assistant turn pushed back into the next round to echo its own
      // reasoning_content verbatim, otherwise the next call 400s with
      // "The `reasoning_content` in the thinking mode must be passed back
      // to the API.". Stored per-round and reset on the next iteration.
      let roundReasoning = "";
      for await (const chunk of iter) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.reasoning_content) {
          roundHadReasoning = true;
          roundReasoning += delta.reasoning_content;
          // Flash-mode users opted out of the thinking UI; do not forward.
          if (mode === "pro") {
            sendEvent({ reasoning: delta.reasoning_content });
          }
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
        // Fallback: pro reasoned but produced no answer. Re-run the same
        // turn in flash so the user always gets a reply.
        if (
          !isMock &&
          !assistantText &&
          roundHadReasoning &&
          Object.keys(accumulated).length === 0
        ) {
          log.warn(
            { round, finishReason, mode },
            "llm.empty-content-after-reasoning, falling back to flash"
          );
          const fb = chatConfig(provider, "flash");
          const fbStream = (await fb.client.chat.completions.create({
            model: fb.model,
            messages,
            stream: true,
            max_tokens: CHAT_MAX_TOKENS,
            ...fb.sampling,
          })) as any;
          for await (const chunk of fbStream) {
            const c = chunk.choices?.[0]?.delta?.content;
            if (c) {
              assistantText += c;
              totalChars += c.length;
              sendEvent({ content: c });
            }
          }
        }

        // Content/tool_calls consistency check (post-validation, 招1
        // reactive form). Detects "I wrote 听语音版/画着呢 but didn't
        // emit the matching tool_call" — the model's most common
        // hallucination pattern. On hit:
        //   1. tell client to retract the bad text it just streamed
        //   2. push the bad assistant turn + a corrective system msg
        //      back into the LLM context
        //   3. re-run THIS round with tool_choice forced to the
        //      missing tool — the model can't refuse to call it
        // Capped at retriesLeft (default 1) so a misaligned model
        // can't spin forever.
        const halluTool = detectHallucinatedTool(
          assistantText,
          toolsCalledThisTurn
        );
        const haveToolDef = !!(tools as ToolDef[] | undefined)?.some(
          (t) => t.function.name === halluTool
        );
        if (halluTool && haveToolDef && retriesLeft > 0) {
          log.info(
            {
              round,
              halluTool,
              retriesLeft,
              textPreview: assistantText.slice(0, 60).replace(/\n/g, " "),
            },
            "validation.hallucination-retry"
          );
          sendEvent({ content_retracted: true });
          messages.push({
            role: "assistant",
            content: assistantText || null,
          });
          messages.push({
            role: "system",
            content: `[CORRECTION] Your previous reply contained text that presupposes you called the ${halluTool} tool ("${assistantText
              .slice(0, 60)
              .replace(/\n/g, " ")}..."), but you did NOT actually emit ${halluTool} as a tool_call. The platform has tracked all your tool calls this turn — the user already noticed. Now ACTUALLY call ${halluTool} with proper arguments. Don't apologize in text, just emit the tool_call.`,
          });
          forceToolChoice = {
            type: "function",
            function: { name: halluTool },
          };
          retriesLeft--;
          round++;
          continue;
        }

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

      // Record the assistant turn with its tool_calls so the next round has
      // context. reasoning_content must be echoed back verbatim — DeepSeek's
      // tool-calling thinking-mode contract requires it; omitting it 400s
      // round 2 with "must be passed back to the API".
      const assistantTurn: any = {
        role: "assistant",
        content: assistantText || null,
        tool_calls: toolCallList.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.args },
        })),
      };
      if (roundReasoning) assistantTurn.reasoning_content = roundReasoning;
      messages.push(assistantTurn);

      // Execute each tool call via the Next.js callback, in series
      for (const tc of toolCallList) {
        // Track for the post-validation hallucination check on later
        // rounds — once a tool is actually called this turn, claims
        // about it in any subsequent text are no longer hallucinations.
        toolsCalledThisTurn.add(tc.name);
        sendEvent({
          tool_call: { id: tc.id, name: tc.name, args: tc.args },
        });
        let toolResultContent = "";
        let ok = false;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), TOOL_CALL_TIMEOUT_MS);
        let parsedResult: unknown = null;
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
          try {
            parsedResult = text ? JSON.parse(text) : null;
          } catch {
            parsedResult = null;
          }
          log.info(
            { round, tool: tc.name, status: res.status, bytes: text.length },
            "tool.result"
          );
        } catch (err: any) {
          toolResultContent = JSON.stringify({
            error: err?.message || "tool call failed",
          });
          parsedResult = { error: err?.message || "tool call failed" };
          log.error({ round, tool: tc.name, err }, "tool.error");
        } finally {
          clearTimeout(timer);
        }
        // Forward the parsed JSON so the web layer can render search hits in
        // the chat UI. `name` is included so the client doesn't have to track
        // call ids back to the earlier `tool_call` event.
        sendEvent({
          tool_result: { id: tc.id, name: tc.name, ok, data: parsedResult },
        });
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
