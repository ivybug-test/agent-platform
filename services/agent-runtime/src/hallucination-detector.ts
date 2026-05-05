/** Patterns the model loves to write WHEN IT THINKS the tool fired,
 *  even if it didn't. If we see one of these in the assistant text
 *  AND the matching tool wasn't actually called this turn, the
 *  model hallucinated and we re-prompt with forced tool_choice.
 *
 *  Bias: **precision >> recall**. False positives here trigger
 *  retract + retry — which is far more painful than a missed catch
 *  (the user just sees a fake "🔊" that doesn't play). Each pattern
 *  must be unambiguously a tool-output reference; "听 X" / "声音" /
 *  "看这张" type general phrases get caught here when the agent
 *  writes natural prose ("作为 AI 我没有真实的声音", "图还在解析中"),
 *  causing the empty-bubble bug. Keep this list TIGHT. */
const SPEAK_HALLUCINATIONS =
  /🔊|🔉|🎙️|听语音版|语音版|\(点.{0,4}听\)|语音已发/;

const IMAGE_HALLUCINATIONS =
  /画着呢|稍等十几秒|稍等几秒|正在画|开始画|画好了|帮你画了|画完了|图已生成|图发给你|附上.{0,3}图/;

export function detectHallucinatedTool(
  text: string,
  toolsCalled: Set<string>
): string | null {
  if (!text) return null;
  if (SPEAK_HALLUCINATIONS.test(text) && !toolsCalled.has("speak")) {
    return "speak";
  }
  if (
    IMAGE_HALLUCINATIONS.test(text) &&
    !toolsCalled.has("generate_image")
  ) {
    return "generate_image";
  }
  return null;
}
