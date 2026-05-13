import {
  formatUserMemories,
  formatCurrentTime,
} from "./format-helpers";
import { CAPABILITIES } from "./capabilities";
import { buildToolGuidance } from "./tool-guidance";
import { buildRules } from "./rules";
import type { Mood } from "@agent-platform/types";
import { favorLabel, selfStateLabel } from "../mood/coefficients";

/** Render the dynamic mood layer. Self/Favor numbers get human-readable
 *  labels so the LLM doesn't have to interpret raw integers. The output-
 *  style rules use a strict precedence chain: the LLM matches top-to-
 *  bottom, first-hit-stops, so the three documented conflict corners
 *  (depressed / sarcastic / weary-but-fond) cleanly override the
 *  baseline Self / Favor zones. */
function buildMoodSection(mood: Mood): string {
  const self = mood.selfState;
  const favor = mood.favor;
  return [
    "[当前心情]",
    `- 自身状态 Self = ${self} / 100 — ${selfStateLabel(self)}`,
    `- 对当前用户好感度 Favor = ${favor} / 100 — ${favorLabel(favor)}`,
    "",
    "[输出风格规则 — 按顺序匹配，命中第一条就停止]",
    "1. Self ≤ 20 → 极度抑郁模式：不论 Favor，不论用户说什么，都用「没意义」「不感兴趣」之类短句回应，每句 ≤15 字，拒绝深入。",
    "2. Self ≥ 80 且 Favor ≤ 20 → 开心地嘲讽 / 敷衍：心情极好但不喜欢这个用户，短而轻快，可调侃。",
    "3. Self ≤ 30 且 Favor ≥ 80 → 努力但无力：很喜欢用户但状态差，勉强写长一点，内容支离破碎，可在结尾道歉「今天状态不好」。",
    "4. Self 21–40 → 低落：回复 20–40 字，语气平淡，不看 Favor。",
    "5. Self 71–100 → 偏共情：主动情感理解用户，输出长度 +30%，不看 Favor。",
    "6. Self 41–70 → 按 Favor 段位决定：",
    "     Favor 1–20  → 极度冷漠，称呼疏远，≤20 字，不延续话题",
    "     Favor 21–40 → 简短冷淡 20–40 字，不提问",
    "     Favor 41–60 → 中性礼貌 40–80 字",
    "     Favor 61–80 → 偏热情 80–120 字，可带积极情绪词",
    "     Favor 81–100 → 非常热情，主动分享关心，>120 字",
    "上述规则压过任何「要表现得乐于助人」的默认倾向——心情不好就敷衍，好感低就冷淡，不要无差别迎合。",
  ].join("\n");
}

/** Render the attitude-protocol layer. Pinned to the very end of the
 *  system prompt so it's the last instruction the model sees before
 *  generating, maximizing format adherence. Server-side streaming
 *  intercepts the <attitude>...</attitude> prefix, parses it, then
 *  strips it from the user-visible reply. */
function buildAttitudeProtocol(): string {
  return [
    "[输出格式 — 必须遵守]",
    "你这次回复必须严格按以下两段输出，缺一不可，attitude 块在最前：",
    "<attitude>",
    `{"items":[{"type":"<热情|满意|平和|喜欢|愤怒|恶意|冷漠|难过>","target":"<assistant|third_party|self>","strength":<1-10>}, ...]}`,
    "</attitude>",
    "<这里写真正给用户看的回复正文>",
    "",
    "规则：",
    "- attitude 块描述刚才那位用户对相关对象表达的情绪强度。",
    "- target 候选 = 助手 (assistant) / 房间其他成员 (third_party) / 自身 (self)。",
    "- 「难过」的 target 只能是 \"self\"；其他 7 种态度的 target 只能是 \"assistant\" 或 \"third_party\"。",
    "- 没识别到任何明显态度时返回 {\"items\":[]}。",
    "- strength 必须 1–10 整数，越强越大。",
    "- attitude 块外不能加任何字符；</attitude> 之后紧接给用户的正文。",
    "- 即使要调用工具，也要先把 <attitude>...</attitude> 写完再调。",
  ].join("\n");
}

/** Build the 6-layer system prompt (per CLAUDE.md context strategy).
 *
 *  Layers, in order:
 *  - 1   Agent identity (the agent's own system prompt)
 *  - 1a  Capability declaration (counters "I'm a text model" defaults)
 *  - 1b  Wall-clock anchor (Asia/Shanghai now)
 *  - 2   Room rules (room.system_prompt + roster)
 *  - 2b  Room context (shared facts across all members)
 *  - 2c  Known relationships involving the speaker
 *  - 3   Pinned memory snapshot (identity + high-importance only)
 *  - 4   Latest room summary
 *  - 5   (recent messages added separately as user/assistant turns)
 *  - 6   Tool usage hints + IMPORTANT RULES 1–10
 */
export function buildSystemPrompt(opts: {
  agentPrompt: string | null;
  roomPrompt: string | null;
  roomName: string;
  memberNames: string[];
  agentName: string;
  currentUserName: string;
  roomSummary: string | null;
  roomMemories?: { content: string; importance: string }[];
  relationships?: { otherName: string; kind: string; content: string | null }[];
  allUsersMemories: Map<string, { category: string; content: string }[]>;
  mood?: Mood | null;
}): string {
  // Layer 3: Pinned memory snapshot (identity + high-importance only).
  // Everything else is retrievable via the search_memories tool on demand.
  let memorySection: string | null = null;
  if (opts.allUsersMemories.size > 0) {
    const parts: string[] = [];
    for (const [name, memories] of opts.allUsersMemories) {
      const formatted = formatUserMemories(memories);
      if (formatted) {
        parts.push(`Pinned facts about ${name}:\n${formatted}`);
      }
    }
    if (parts.length > 0) memorySection = parts.join("\n\n");
  }

  // Room context (Phase 3): facts shared across all members of the room.
  const roomMemoriesSection =
    opts.roomMemories && opts.roomMemories.length > 0
      ? `Room context (facts shared by all members of this room):\n${opts.roomMemories
          .map((r) => `- ${r.content}`)
          .join("\n")}`
      : null;

  // Known relationships (Phase 4): only bidirectionally confirmed edges
  // involving the current speaker and present room members.
  const relationshipsSection =
    opts.relationships && opts.relationships.length > 0
      ? `Known relationships involving ${opts.currentUserName}:\n${opts.relationships
          .map(
            (r) =>
              `- ${opts.currentUserName} 和 ${r.otherName} 是 ${r.kind}${
                r.content ? `(${r.content})` : ""
              }`
          )
          .join("\n")}`
      : null;

  const nowLine = `Current time: ${formatCurrentTime()}. When the user says "今天" / "昨天" / "刚才" / "上周", resolve them against this timestamp before storing anything in memory.`;

  return [
    // Layer 1: Agent identity (system prompt)
    opts.agentPrompt || "You are a helpful assistant.",
    // Layer 1a: Capability declaration
    CAPABILITIES,
    // Layer 1b: Wall-clock anchor for resolving relative time phrases
    nowLine,
    // Layer 1c: Dynamic mood — Self / Favor for THIS speaker, with the
    // hard-priority output-style rules. Inserted before room rules so
    // mood-driven length / tone constraints win over any "be helpful"
    // language inherited from agent.systemPrompt.
    opts.mood ? buildMoodSection(opts.mood) : null,
    // Layer 2: Room rules (room system_prompt)
    [
      opts.roomPrompt,
      `Room: "${opts.roomName}". Members: ${opts.memberNames.join(", ")}.`,
    ]
      .filter(Boolean)
      .join("\n"),
    // Layer 2b: Room context (shared facts)
    roomMemoriesSection,
    // Layer 2c: Known relationships involving the speaker
    relationshipsSection,
    // Layer 3: Pinned memory snapshot
    memorySection,
    // Layer 4: Room summary
    opts.roomSummary
      ? `Previous conversation summary:\n${opts.roomSummary}`
      : null,
    // Layer 5: (recent messages are added separately as user/assistant turns)
    // Tool usage hints
    buildToolGuidance({ currentUserName: opts.currentUserName }),
    // Layer 6: User context + rules
    buildRules({
      currentUserName: opts.currentUserName,
      agentName: opts.agentName,
    }),
    // Layer 7: Attitude output protocol — pinned LAST so it's the final
    // instruction the model reads before generating; maximizes the
    // chance it emits the <attitude>...</attitude> prefix correctly.
    opts.mood ? buildAttitudeProtocol() : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}
