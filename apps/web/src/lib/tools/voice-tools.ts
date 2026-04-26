import type { ToolHandler } from "./index";

/** `speak` is a marker tool — the actual TTS happens lazily on the
 *  client when the user clicks the 🔊 button on the agent bubble. The
 *  tool itself just confirms receipt; stream.ts pulls `text` out of the
 *  matching tool_call event and persists it to `messages.metadata.audio`
 *  so a refresh / second client both see the play button.
 *
 *  We deliberately don't pre-warm /api/tts here: synthesizing for
 *  every reply would burn quota even when the user never clicks. The
 *  metadata write is enough to surface the button. */
const speak: ToolHandler = async (args) => {
  const text = typeof args?.text === "string" ? args.text.trim() : "";
  if (!text) return { error: "text is required" };
  if (text.length > 2000) return { error: "text too long (max 2000 chars)" };
  return { data: { ok: true } };
};

export const voiceToolHandlers: Record<string, ToolHandler> = {
  speak,
};

export const voiceToolDefs = [
  {
    type: "function" as const,
    function: {
      name: "speak",
      description:
        "Mark this reply as having a spoken/audio version. Call this whenever the user wants something heard, NOT just when they say the literal word '语音'. Concrete triggers: (1) explicit voice asks — 用语音 / 念一下 / 说一遍 / 朗读 / say it aloud / read it to me; (2) imitation / sound effects — 学猫叫 / 学狗叫 / 学 X 的声音 / 模仿 X / mimic / impersonate; (3) singing — 唱一段 / 唱首歌 / sing X / hum X; (4) short utterances the user clearly wants vocalised — 说 'hello' / 跟我说 X / 说句话 / say hi; (5) anything where your written reply is itself a sound (\"喵喵喵\", \"汪~\", \"嘿嘿\") — call speak with the same text so the user can actually hear it. When in doubt, prefer calling speak — a play button the user ignores is far less bad than missing one when they wanted to hear it. The text passed becomes the audio when the user taps 🔊; it can be shorter / more conversational than the visible reply (drop markdown, expand abbreviations). After calling, still write a normal text reply (or just the same content as the speak text for short utterances). One call per reply.",
      parameters: {
        type: "object",
        required: ["text"],
        properties: {
          text: {
            type: "string",
            description:
              "Plain spoken-language text. No markdown, no URLs, no code blocks. Cap 2000 chars.",
          },
        },
      },
    },
  },
];
