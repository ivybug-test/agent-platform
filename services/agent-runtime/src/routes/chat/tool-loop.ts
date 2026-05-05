import { chatConfig, type Provider, type DeepSeekMode } from "../../llm.js";
import { mockToolStream } from "../../mock.js";
import {
  CHAT_MAX_TOKENS,
  TOOL_CALL_TIMEOUT_MS,
  TRUNCATION_MAX_CONTINUATIONS,
} from "../../constants.js";
import { detectHallucinatedTool } from "../../hallucination-detector.js";
import type {
  ToolDef,
  ToolChoice,
  AccumulatedToolCall,
} from "../../types.js";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("agent-runtime");

interface ToolLoopArgs {
  initialMessages: any[];
  tools: ToolDef[];
  toolCallbackUrl: string;
  toolAuth: string;
  maxRounds: number;
  provider: Provider;
  mode: DeepSeekMode;
  requestedToolChoice: ToolChoice | undefined;
  isMock: boolean;
  startTime: number;
  sendEvent: (obj: unknown) => void;
}

/** Multi-round tool-calling loop. Streams content + tool_call /
 *  tool_result events. Detects content/tool_calls inconsistencies
 *  ("I wrote '听语音版' but didn't emit speak") and retries once with
 *  forced tool_choice on the missing tool. */
export async function runToolLoop({
  initialMessages,
  tools,
  toolCallbackUrl,
  toolAuth,
  maxRounds,
  provider,
  mode,
  requestedToolChoice,
  isMock,
  startTime,
  sendEvent,
}: ToolLoopArgs) {
  const messages: any[] = [...initialMessages];
  let totalChars = 0;
  let round = 0;
  let done = false;
  // Observability for the post-stream summary log. We need to
  // distinguish:
  //   - B1 (副作用工具调完没补文字 — 正常): totalToolCalls>0,
  //     speak/generate_image ∈ allToolNames, lastAssistantTextLength=0
  //   - B2 (reasoning 完没出 content — 真 bug): totalToolCalls=0,
  //     anyRoundHadReasoning=true, lastAssistantTextLength=0
  //   - 截断: lastFinishReason='length'
  // These dimensions feed the upcoming final-synthesis fallback so
  // we know the real occurrence rates before tuning thresholds.
  let totalToolCalls = 0;
  let anyRoundHadReasoning = false;
  let lastFinishReason: string | null = null;
  let lastAssistantTextLength = 0;
  const allToolNames: string[] = [];

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
      let roundToolChoice: ToolChoice =
        forceToolChoice ?? requestedToolChoice ?? "auto";
      forceToolChoice = null;
      // DeepSeek API rejects BOTH `{type:"function", function:{name}}` AND
      // `"required"` with 400 (verified 2026-05-05). Only "auto" / "none"
      // are accepted. Both the web-side router AND the post-validation
      // hallucination retry would otherwise 400 on every fire — the
      // outer catch swallows them as "llm error" and the user sees
      // nothing. Downgrade to "auto"; final-synthesis fallback handles
      // the "no tool called" outcome.
      if (provider === "deepseek" && typeof roundToolChoice === "object") {
        log.info(
          {
            round,
            wouldHaveForced: roundToolChoice.function.name,
          },
          "tool-loop.deepseek-force-downgrade"
        );
        roundToolChoice = "auto";
      }

      const iter: AsyncIterable<any> = await (async () => {
        if (isMock) {
          return mockToolStream(
            round,
            tools.map((t) => t.function.name)
          );
        }
        const cfg = chatConfig(provider, mode);
        const callLLM = (tc: ToolChoice) =>
          cfg.client.chat.completions.create({
            model: cfg.model,
            messages,
            tools: tools as any,
            tool_choice: tc,
            stream: true,
            max_tokens: CHAT_MAX_TOKENS,
            ...cfg.sampling,
          });
        try {
          return (await callLLM(roundToolChoice)) as any;
        } catch (err: any) {
          // Generic safety net for any provider that rejects a
          // non-"auto" tool_choice with 400 (DeepSeek does, Kimi might).
          // We've already pre-downgraded for DeepSeek above; this catch
          // covers future regressions / new providers / Kimi specifics.
          // Anything beyond 400 — auth, network, server — bubbles up.
          const status = err?.status ?? err?.response?.status;
          const isToolChoice400 =
            status === 400 &&
            roundToolChoice !== "auto" &&
            /tool_choice/i.test(
              `${err?.message || ""} ${err?.response?.data?.error?.message || ""}`
            );
          if (isToolChoice400) {
            log.warn(
              { round, rejected: roundToolChoice, errMsg: err?.message },
              "tool-loop.tool-choice-rejected-falling-back-to-auto"
            );
            roundToolChoice = "auto";
            return (await callLLM("auto")) as any;
          }
          throw err;
        }
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

      // Snapshot per-round outcomes for the final summary log. These
      // get overwritten each iteration so the values reflect the LAST
      // round (which is the one that produced the user-visible reply).
      if (roundHadReasoning) anyRoundHadReasoning = true;
      lastFinishReason = finishReason;
      lastAssistantTextLength = assistantText.length;

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

        // Truncation continuation: finish_reason='length' means the
        // model hit max_tokens mid-sentence. Push what we have as the
        // assistant turn, ask "请继续" as the next user turn, and stream
        // the continuation. Capped so a runaway "continue" loop can't
        // spin forever. No tools — once the model committed to writing
        // text, the continuation should stay in text mode.
        let continuationsLeft = TRUNCATION_MAX_CONTINUATIONS;
        while (
          !isMock &&
          finishReason === "length" &&
          assistantText &&
          continuationsLeft > 0
        ) {
          log.info(
            {
              round,
              continuationsLeft,
              partialLen: assistantText.length,
            },
            "llm.truncation-continue"
          );
          const contMessages = [
            ...messages,
            { role: "assistant", content: assistantText },
            { role: "user", content: "请继续" },
          ];
          const cfg = chatConfig(provider, mode);
          const contStream = (await cfg.client.chat.completions.create({
            model: cfg.model,
            messages: contMessages,
            stream: true,
            max_tokens: CHAT_MAX_TOKENS,
            ...cfg.sampling,
          })) as any;
          let contFinishReason: string | null = null;
          for await (const chunk of contStream) {
            const ch = chunk.choices?.[0];
            const c = ch?.delta?.content;
            if (c) {
              assistantText += c;
              totalChars += c.length;
              sendEvent({ content: c });
            }
            if (ch?.finish_reason) contFinishReason = ch.finish_reason;
          }
          finishReason = contFinishReason;
          lastFinishReason = finishReason;
          lastAssistantTextLength = assistantText.length;
          continuationsLeft--;
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
        //
        // CAVEAT (DeepSeek): the retry pushes tool_choice={function:
        // {name}} which DeepSeek rejects with 400 — our defense layer
        // above downgrades it back to "auto", neutering the retry. So
        // the retract WIPES the user's already-streamed text but the
        // retry can't reliably refill it, leaving an empty bubble.
        // Skip the retract+retry entirely on DeepSeek: a slightly off
        // text response is far better than an empty bubble. Keeps the
        // mechanism live for Kimi (where forced tool_choice works).
        const canForceTool = provider !== "deepseek";
        const halluTool = canForceTool
          ? detectHallucinatedTool(assistantText, toolsCalledThisTurn)
          : null;
        const haveToolDef = !!tools.some(
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

      totalToolCalls += toolCallList.length;
      for (const tc of toolCallList) allToolNames.push(tc.name);

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
    }

    // B2 final-synthesis fallback. If the loop ended with no visible
    // text in the last round AND something happened that should normally
    // produce one (reasoning attempted, OR a non-side-effect tool ran)
    // — including the max-rounds case — run a no-tool flash call to
    // turn the conversation we already have into a user-facing answer.
    // Side-effect-only turns (speak / generate_image alone) are B1, not
    // B2: those tools' user-visible output IS the audio button / image,
    // and we skip synthesis so we don't bolt on redundant text.
    const SIDE_EFFECT_TOOLS = new Set(["speak", "generate_image"]);
    const needsSynthesis =
      !isMock &&
      lastAssistantTextLength === 0 &&
      (anyRoundHadReasoning ||
        (totalToolCalls > 0 &&
          allToolNames.some((n) => !SIDE_EFFECT_TOOLS.has(n))) ||
        !done);
    if (needsSynthesis) {
      log.warn(
        {
          rounds: round,
          toolCallCount: totalToolCalls,
          toolNames: allToolNames,
          hadReasoning: anyRoundHadReasoning,
          maxRoundsHit: !done,
        },
        "llm.final-synthesis-fallback"
      );
      try {
        const fb = chatConfig(provider, "flash");
        const synthMessages = [
          ...messages,
          {
            role: "system" as const,
            content:
              "请基于上面的工具结果和对话，给用户一个简洁直接的回答。不要再调用工具，不要重复思考过程，直接说结论。",
          },
        ];
        const synthStream = (await fb.client.chat.completions.create({
          model: fb.model,
          messages: synthMessages,
          stream: true,
          max_tokens: CHAT_MAX_TOKENS,
          ...fb.sampling,
        })) as any;
        for await (const chunk of synthStream) {
          const c = chunk.choices?.[0]?.delta?.content;
          if (c) {
            totalChars += c.length;
            lastAssistantTextLength += c.length;
            sendEvent({ content: c });
          }
        }
      } catch (synthErr) {
        log.error({ synthErr }, "llm.final-synthesis-failed");
        // Last resort — at least send SOMETHING so the bubble isn't empty.
        if (lastAssistantTextLength === 0) {
          sendEvent({ content: "（生成回复时出错，请重试）" });
        }
      }
    }

    log.info(
      {
        duration: Date.now() - startTime,
        totalChars,
        rounds: round,
        toolCallCount: totalToolCalls,
        toolNames: allToolNames,
        finishReason: lastFinishReason,
        hadReasoning: anyRoundHadReasoning,
        lastAssistantTextLength,
        mode,
      },
      "llm.complete"
    );
  } catch (err) {
    log.error({ err, round, duration: Date.now() - startTime }, "llm.error");
    sendEvent({ error: "llm error" });
  }
}
