import type { TTSVoice } from "./types";

/** Curated MiniMax preset voices for the picker. The MiniMax catalog is
 *  much larger; we surface a handful of named ones that play well for
 *  Chinese conversational use cases. Add more as needed.
 *
 *  Voice ids come from MiniMax's "system voice" list — no extra training
 *  cost. Custom-cloned voices live in a different tier and aren't
 *  exposed here. */
export const MINIMAX_VOICES: TTSVoice[] = [
  { id: "male-qn-qingse", name: "青涩少年（男）", provider: "minimax", gender: "male", language: "zh" },
  { id: "male-qn-jingying", name: "精英青年（男）", provider: "minimax", gender: "male", language: "zh" },
  { id: "female-shaonv", name: "少女（女）", provider: "minimax", gender: "female", language: "zh" },
  { id: "female-yujie", name: "御姐（女）", provider: "minimax", gender: "female", language: "zh" },
  { id: "female-chengshu", name: "成熟女性（女）", provider: "minimax", gender: "female", language: "zh" },
  { id: "audiobook_male_1", name: "有声书男声", provider: "minimax", gender: "male", language: "zh" },
  { id: "audiobook_female_1", name: "有声书女声", provider: "minimax", gender: "female", language: "zh" },
];

/** Mock provider has one silent voice — visible during local dev when
 *  no MiniMax key is configured. */
export const MOCK_VOICES: TTSVoice[] = [
  { id: "silent", name: "Silent (mock)", provider: "mock", gender: "neutral" },
];
