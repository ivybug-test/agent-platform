/** Detect @agent mention and return cleaned content */
export function parseMention(content: string, agentName: string) {
  const pattern = new RegExp(`@(?:agent|assistant|${agentName})\\b`, "i");
  const hasMention = pattern.test(content);
  const cleanContent = content.replace(pattern, "").trim();
  return { hasMention, cleanContent };
}
