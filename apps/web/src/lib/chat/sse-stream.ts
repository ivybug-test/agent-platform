/** Parsed shapes of every event the agent-runtime SSE stream emits.
 *  Mirrors the dispatch in services/agent-runtime/src/routes/chat/
 *  tool-loop.ts. Add a new variant here when you add a new event
 *  shape upstream so the consumer's exhaustiveness check trips. */
export type SSEEvent =
  | { type: "content"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "content_retracted" }
  | { type: "tool_call"; id: string; name: string; args: string }
  | {
      type: "tool_result";
      id: string;
      name?: string;
      ok: boolean;
      data?: unknown;
    }
  | { type: "done"; messageId?: string }
  | { type: "error"; message: string };

/** Read the response body line-by-line (`data: …` / `[DONE]` framing),
 *  parse each JSON payload, and yield typed events. Malformed JSON or
 *  unrecognized shapes are silently skipped — same forgiving behavior
 *  as the pre-extraction inline reader. The generator returns when
 *  the stream closes; callers don't need to track buffer / decoder
 *  state. */
export async function* parseSSE(
  response: Response
): AsyncGenerator<SSEEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;
      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;

      // Order matters slightly: `done` is a terminal-ish event and
      // pairs with messageId — yield first so the consumer can
      // dedup before processing any straggling chunks (the server
      // may still emit `[DONE]` after).
      if (parsed.done && typeof parsed.messageId === "string") {
        yield { type: "done", messageId: parsed.messageId };
        continue;
      }
      if (parsed.content_retracted) {
        yield { type: "content_retracted" };
        continue;
      }
      if (typeof parsed.reasoning === "string" && parsed.reasoning) {
        yield { type: "reasoning", text: parsed.reasoning };
      }
      if (typeof parsed.content === "string" && parsed.content) {
        yield { type: "content", text: parsed.content };
      }
      if (parsed.tool_call) {
        const tc = parsed.tool_call;
        yield {
          type: "tool_call",
          id: String(tc.id || ""),
          name: String(tc.name || ""),
          args: String(tc.args || ""),
        };
      }
      if (parsed.tool_result) {
        const tr = parsed.tool_result;
        yield {
          type: "tool_result",
          id: String(tr.id || ""),
          name: typeof tr.name === "string" ? tr.name : undefined,
          ok: !!tr.ok,
          data: tr.data,
        };
      }
      if (typeof parsed.error === "string" && parsed.error) {
        yield { type: "error", message: parsed.error };
      }
    }
  }
}
