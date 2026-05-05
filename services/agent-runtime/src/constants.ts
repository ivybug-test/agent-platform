// 30s. Web search tool chains do Bocha → optional Tavily fallback, plus
// remote provider RTT — cumulative slow case can comfortably exceed 15s
// on a CN box hitting Tavily. Hitting the timeout is the most common
// way users see a generic "tool call failed" with no detail.
export const TOOL_CALL_TIMEOUT_MS = 30000;

export const DEFAULT_MAX_TOOL_ROUNDS = 5;
export const HARD_TOOL_ROUND_CAP = 10;

// Cap the final answer at 8192 tokens. DeepSeek's `max_tokens` only
// counts visible output (chain-of-thought has its own internal budget),
// so this just guards against runaway answers — it does NOT shrink the
// reasoning window. Continuation logic in tool-loop.ts handles
// finish_reason='length' for the rare case we still hit it.
export const CHAT_MAX_TOKENS = 8192;
// Max times we'll auto-continue a finish_reason='length' truncated
// reply before giving up. Each continuation is a fresh LLM call with
// "请继续" as the next user turn; the model picks up where it stopped.
export const TRUNCATION_MAX_CONTINUATIONS = 2;
