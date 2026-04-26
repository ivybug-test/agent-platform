import type { ToolHandler } from "./index";

/** Allowed voice ids for per-call override. Kept in sync with
 *  apps/web/src/lib/tts/voices.ts MINIMAX_VOICES — when adding voices
 *  there, mirror them here so the agent only picks ones we actually
 *  ship. Defaults flow naturally: omit voiceId → /api/tts falls back
 *  to the agent's globally-configured voice (set on /me). */
const ALLOWED_VOICE_IDS = new Set([
  "male-qn-qingse",
  "male-qn-jingying",
  "female-shaonv",
  "female-yujie",
  "female-chengshu",
  "audiobook_male_1",
  "audiobook_female_1",
]);

/** `speak` is a marker tool — the actual TTS happens lazily on the
 *  client when the user clicks the 🔊 button on the agent bubble. The
 *  tool itself just confirms receipt; stream.ts pulls `text` (and
 *  optional `voiceId`) out of the matching tool_call event and
 *  persists them to `messages.metadata.audio` so a refresh / second
 *  client both see the play button + use the right voice.
 *
 *  We deliberately don't pre-warm /api/tts here: synthesizing for
 *  every reply would burn quota even when the user never clicks. The
 *  metadata write is enough to surface the button. */
const speak: ToolHandler = async (args) => {
  const text = typeof args?.text === "string" ? args.text.trim() : "";
  if (!text) return { error: "text is required" };
  if (text.length > 2000) return { error: "text too long (max 2000 chars)" };
  const rawVoiceId = typeof args?.voiceId === "string" ? args.voiceId.trim() : "";
  if (rawVoiceId && !ALLOWED_VOICE_IDS.has(rawVoiceId)) {
    return { error: `unknown voiceId: ${rawVoiceId.slice(0, 60)}` };
  }
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
          voiceId: {
            type: "string",
            enum: [
              "male-qn-qingse",
              "male-qn-jingying",
              "female-shaonv",
              "female-yujie",
              "female-chengshu",
              "audiobook_male_1",
              "audiobook_female_1",
            ],
            description:
              "Optional override for the agent's default voice (set by the user on the /me page). OMIT this field for normal replies — the user's chosen voice is the right default. PASS one of the enum values when ANY of these triggers fire: (a) directional ask — '用男声/女声/温柔的声音/老成的声音' / 'sound like X / use a male voice'; (b) generic switch ask — '换一种声音 / 换个声音 / 换个音色 / 试试别的声音 / 用另一种声音 / try a different voice / switch voice' (pick anything from the enum that fits the message tone, ANY change is the point); (c) roleplay vocal-character mismatch — story narrator (audiobook_male_1 / audiobook_female_1), playing a young female character (female-shaonv 少女), confident female (female-yujie 御姐), older / mature woman (female-chengshu 成熟女性), gentle young male (male-qn-qingse 青涩少年), sharp / professional male (male-qn-jingying 精英青年). For (b) the user just wants a change, so don't agonize — pick any voice that isn't obviously wrong for the content and ship it.",
          },
        },
      },
    },
  },
];
