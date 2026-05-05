// 30s. Web search tool chains do Bocha → optional Tavily fallback, plus
// remote provider RTT — cumulative slow case can comfortably exceed 15s
// on a CN box hitting Tavily. Hitting the timeout is the most common
// way users see a generic "tool call failed" with no detail.
export const TOOL_CALL_TIMEOUT_MS = 30000;

export const DEFAULT_MAX_TOOL_ROUNDS = 5;
export const HARD_TOOL_ROUND_CAP = 10;

// Cap the final answer at 4096 tokens. DeepSeek's `max_tokens` only
// counts visible output (chain-of-thought has its own internal budget),
// so this just guards against runaway answers — it does NOT shrink the
// reasoning window.
export const CHAT_MAX_TOKENS = 4096;
