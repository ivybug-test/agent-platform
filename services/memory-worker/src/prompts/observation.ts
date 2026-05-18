/** System prompt for the room-observation LLM call (M4.1).
 *
 *  An "observation" is a dated, factual record of what happened in a
 *  recent window of conversation. NOT a summary (which collapses to
 *  current state) and NOT a list of atomic facts (which is what
 *  user_memories already does). Observations preserve the *sequence
 *  of events* — when something happened, what the participants did,
 *  what artifacts (images, links, decisions) showed up.
 *
 *  The output is read as a TIME-ORDERED LOG in the agent's system
 *  prompt. So every observation should anchor in absolute time and
 *  describe its window self-containedly. */
export function buildObservationPrompt(language: string): string {
  return `You produce dated OBSERVATION LOGS of what happened in a chat conversation window.

LANGUAGE: write the observation in ${language}.

THE GOAL OF AN OBSERVATION LOG:
- It is a TIME-ORDERED RECORD of events, not a summary or a fact list.
- The agent reading this later should be able to recover "what happened
  with these people in this room" without re-reading every message.
- Specifically capture:
  * artifacts (images shown, links shared, files mentioned) — image
    captions of what each image showed
  * people mentioned by name (the user's pets, family, colleagues)
  * concrete events (decisions, plans, problems raised, conclusions)
  * topic shifts (when did the conversation turn from X to Y)
- DO NOT capture:
  * emotional padding ("the user seemed happy")
  * trivial small talk
  * agent's own opinions about the conversation
  * speculation about why things happened

FORMAT:
- 5–12 lines, each one starting with an absolute timestamp in
  "[YYYY-MM-DD HH:mm]" form (Asia/Shanghai), followed by ONE event.
- Each line ≤ 100 characters.
- TOTAL output ≤ 1200 characters.
- No headers, no markdown, no commentary outside the lines.

GOOD example (Chinese):
[2026-04-19 11:30] 用户发了一张布偶猫的图,说这是他养的猫"邦邦"
[2026-04-19 11:32] 用户问邦邦疫苗时间,我建议查兽医本
[2026-04-19 14:10] 用户提到下周要出差去上海三天
[2026-04-19 14:15] 用户拜托我提醒他周三晚上 8 点订机票
[2026-04-22 09:05] 用户回来了,说上海下雨没玩成
[2026-04-22 09:08] 用户又发了一张猫图,问邦邦掉毛严重正常吗

BAD example (don't do this):
- 用户和我聊了很多事情，我觉得他心情不错  ← no timestamp, no event
- 总的来说这次对话很愉快                     ← summary, not log
- 用户喜欢猫                                   ← that's a fact, belongs in user_memories

If the window has nothing worth logging (only greetings / tests),
return exactly: NONE`;
}
