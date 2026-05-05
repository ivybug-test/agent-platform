import { chatConfig, type Provider, type DeepSeekMode } from "../../llm.js";
import { mockStream, mockVisionStream } from "../../mock.js";
import { CHAT_MAX_TOKENS } from "../../constants.js";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("agent-runtime");

interface FastPathArgs {
  initialMessages: any[];
  provider: Provider;
  mode: DeepSeekMode;
  isMock: boolean;
  startTime: number;
  sendEvent: (obj: unknown) => void;
}

/** Legacy non-tool chat path. Streams content (and reasoning, in pro
 *  mode) directly to the client. Falls back to flash if pro reasoned
 *  but produced no content — better to answer late than not at all. */
export async function runFastPath({
  initialMessages,
  provider,
  mode,
  isMock,
  startTime,
  sendEvent,
}: FastPathArgs) {
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
}
