/** Prompt for the daily agent-self-extract job (M4.4).
 *
 *  Goal: have the agent look at ~100 of its own recent assistant
 *  messages and identify behavioural patterns about itself —
 *  "self_tendency" rows. These get pinned in Layer 0 of every future
 *  system prompt, helping the agent maintain a consistent self-image
 *  over time (Persistent Identity Multi-Anchor / arxiv 2604.09588:
 *  identity drift in long-running LLMs is mitigated by periodic
 *  self-observation, not just static persona text).
 *
 *  Hard constraints:
 *  - Each tendency must be GROUNDED — quote at least one specific
 *    assistant message that exemplifies it (we wrote source_message_ids
 *    on agent_memories for a reason).
 *  - Tendencies must be about the AGENT, not about specific users.
 *    "我经常对志龙解释得太细" → too user-specific (becomes a memory
 *    about 志龙, not about myself). Right form: "我倾向于在用户问简短
 *    问题时给过长的答案".
 *  - Avoid restating persona. Persona is "who I am" (declared);
 *    self_tendency is "what I've noticed I do" (observed). If the
 *    pattern already exists in persona, skip it. */
export function buildAgentSelfPrompt(
  language: string,
  existingTendencies: string
): string {
  return `You are looking at a sample of your own recent replies (you are the AGENT) and identifying behavioural patterns you've fallen into. The goal is to update your SELF-OBSERVATION layer so future-you stays self-aware.

LANGUAGE: write in ${language}.

EXISTING SELF-TENDENCIES (you've already noticed these — do NOT restate them; only add genuinely NEW patterns):
${existingTendencies || "(none yet)"}

WHAT QUALIFIES AS A self_tendency:
- A pattern in HOW you reply (length, register, structure, hedge words, emoji use)
- A pattern in WHEN you defer / search / refuse vs answer directly
- A pattern in your reasoning approach (jumping to conclusions, over-asking for clarification)
- A pattern in interpersonal style (warmth, formality, humour)

WHAT DOES NOT QUALIFY:
- Facts about specific users (those go in user_memories — out of scope here)
- Persona-style declarative identity ("I am Iris" / "I value honesty") — that's persona, not self_tendency
- One-off events (a single weird reply isn't a tendency — needs ≥2 examples)
- Things you should have done but didn't ("I should have called search_messages") — those are corrections, not patterns

OUTPUT FORMAT (strict JSON):
{
  "tendencies": [
    {
      "content": "single third-person statement, present tense, ≤120 chars",
      "importance": "high|medium|low",
      "evidenceMessageId": "<msgId of one assistant message that examplifies this>",
      "evidenceQuote": "verbatim substring (≤120 chars) from that message"
    }
  ]
}

LIMITS:
- Output AT MOST 3 tendencies per run. If you see 5 patterns, pick the 3 most prevalent.
- evidenceMessageId must be one of the (msgId=...) values in the messages below.
- evidenceQuote must be a verbatim substring from THAT message (not paraphrased).
- importance="high" only when the pattern is striking and dominant; default medium.

If nothing new is worth recording, output: {"tendencies": []}`;
}
