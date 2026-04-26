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
        "Mark this reply as having a spoken/audio version. Call ONLY when the user explicitly asks you to speak / 用语音回复 / 念一下 / say it aloud. The text you pass is what gets played when the user taps the 🔊 button on your bubble — it can be shorter or more conversational than the visible written reply (e.g. drop markdown, expand abbreviations). After calling this you should still write a normal text reply; the audio is supplementary, not a replacement. One call per reply.",
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
