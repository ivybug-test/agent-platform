/** System prompt for the Reflection v1 synthesis LLM call. Input: a
 *  cluster of event-level user_memories that the worker has pre-
 *  grouped by semantic similarity (cosine ≤ 0.35). Output: at most ONE
 *  higher-order pattern fact, or "no pattern" if the cluster doesn't
 *  actually reveal one.
 *
 *  Why this is gated: per the plan, reflection's job is to kill
 *  "fragmented but no big picture" — we want "经常熬夜赶 ddl" emerging
 *  from 5 dated 熬夜 events, NOT a restatement of any single event. The
 *  prompt has to be aggressive about rejecting weak clusters; better
 *  no reflection than a wrong one.
 */
export function buildReflectionPrompt(
  language: string,
  nowIso: string,
  userName: string
): string {
  return `You are extracting a higher-order behavioural pattern from a CLUSTER of
already-summarised event memories about user "${userName}". The cluster was
formed by semantic similarity — the events all look like they're about the
same topic, but it's up to you to decide if they reveal a stable PATTERN
worth elevating to a long-term fact.

LANGUAGE (HIGHEST PRIORITY):
The cluster is in ${language}. Your output pattern MUST be in ${language}.
Do NOT translate. Do NOT use English unless the cluster is in English.

CURRENT TIME: ${nowIso} (Asia/Shanghai)

WHAT COUNTS AS A PATTERN:
A pattern is a stable, recurring trait or behaviour that holds across the
cluster — NOT a restatement of any single event.
  Cluster: ["2026-04-18 熬夜赶论文", "2026-04-22 凌晨 2 点睡", "2026-04-29 熬夜改 ppt"]
  ✓ Pattern: "经常熬夜赶 ddl" (high importance, the user does this repeatedly)
  ✗ NOT a pattern: "2026-04-18 熬夜赶论文" (just one event verbatim)
  ✗ NOT a pattern: "用户最近很累" (an emotional state, not stable behaviour)

Other valid pattern shapes:
  - Recurring preference: "经常和朋友打游戏到深夜"
  - Recurring concern: "持续在求职 / 投简历"
  - Recurring habit: "每周末徒步"
  - Recurring relationship pattern: "和妈妈每周通话"

WHEN TO RETURN hasPattern: false (FAIL CLOSED — better silent than wrong):
- Cluster size is small (≤2 events) and you can't infer recurrence
- Events look superficially similar but represent unrelated decisions
- One event dominates; the rest are noise
- The "pattern" would just be one of the events restated
- The events are too far apart in time (e.g. one 2025-12 + one 2026-04
  doesn't make a habit)

OUTPUT FORMAT (strict JSON, no markdown):
{
  "hasPattern": true,
  "pattern": "经常熬夜赶 ddl",
  "importance": "medium",
  "representativeQuote": "2026-04-22 凌晨 2 点睡"
}

OR, if no pattern:
{ "hasPattern": false }

FIELD RULES:
- pattern: single concise third-person fact (≤30 chars CN / ≤80 chars EN);
  no relative time phrases ("最近"/"经常"/"often" are fine; "今天"/"昨天"
  are NOT — pattern transcends specific dates); same language as cluster
- importance: "high" / "medium" / "low" — pick based on how durable + how
  many events back it. Default "medium". Reserve "high" for clearly
  identity-shaping patterns (≥5 events spanning ≥2 weeks).
- representativeQuote: optional, ≤80 chars, one of the most illustrative
  events from the cluster verbatim. Used as evidence shown to the agent.

DO NOT:
- Output more than one pattern per call (caller already pre-clustered)
- Restate or summarise the events one-by-one
- Speculate about why the user does this — only WHAT they repeatedly do
- Output anything outside the JSON object`;
}
