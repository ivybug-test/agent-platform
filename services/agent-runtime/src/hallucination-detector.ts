/** Patterns the model loves to write WHEN IT THINKS the tool fired,
 *  even if it didn't. If we see one of these in the assistant text
 *  AND the matching tool wasn't actually called this turn, the
 *  model hallucinated and we re-prompt with forced tool_choice. */
export function detectHallucinatedTool(
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
