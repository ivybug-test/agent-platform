import type {
  AttitudeItem,
  AttitudeTarget,
  AttitudeType,
} from "@agent-platform/types";

// Default starting point per docs/agent_mood_design.md §2.
export const DEFAULT_SELF_STATE = 60;
export const DEFAULT_FAVOR = 50;

export const MOOD_MIN = 1;
export const MOOD_MAX = 100;

// Per-(attitude, target) coefficients. 6 entries come directly from the
// design doc examples; the rest are filled in by inference and live here
// so they can be tuned without touching the call site. Semantics:
//   - target=assistant: speaker addressing the agent directly. Doesn't
//     move the agent's own well-being (k_self=0) — only how much they
//     want to engage with this specific user (k_favor).
//   - target=third_party: speaker showing an attitude toward someone
//     else in the room. The agent observes and is moved both
//     emotionally (k_self) and relationally (k_favor).
//   - target=self: ONLY 难过. Speaker sad about themselves; agent
//     mirrors slightly downward + small favor dip from emotional cost.
//
// k_self ∈ ℝ ; k_favor ∈ ℝ ; both multiplied by item.strength (1–10),
// summed across all items in a message, then applied as ΔSelf / ΔFavor.
interface Coeff {
  kSelf: number;
  kFavor: number;
}

type CoeffKey = `${AttitudeType}:${AttitudeTarget}`;

export const COEFFICIENTS: Record<CoeffKey, Coeff> = {
  // 愤怒
  "愤怒:assistant": { kSelf: 0, kFavor: -1.4 },
  "愤怒:third_party": { kSelf: -0.6, kFavor: -0.3 }, // doc example 2
  "愤怒:self": { kSelf: 0, kFavor: 0 }, // disallowed; defensive zero

  // 满意
  "满意:assistant": { kSelf: 0, kFavor: 1.0 },
  "满意:third_party": { kSelf: 0.3, kFavor: 0.2 },
  "满意:self": { kSelf: 0, kFavor: 0 },

  // 恶意
  "恶意:assistant": { kSelf: 0, kFavor: -1.5 }, // doc example 2
  "恶意:third_party": { kSelf: -0.7, kFavor: -0.4 },
  "恶意:self": { kSelf: 0, kFavor: 0 },

  // 冷漠
  "冷漠:assistant": { kSelf: 0, kFavor: -0.6 },
  "冷漠:third_party": { kSelf: -0.4, kFavor: -0.2 }, // doc example 1
  "冷漠:self": { kSelf: 0, kFavor: 0 },

  // 热情
  "热情:assistant": { kSelf: 0, kFavor: 1.2 }, // doc example 1
  "热情:third_party": { kSelf: 0.5, kFavor: 0.3 },
  "热情:self": { kSelf: 0, kFavor: 0 },

  // 平和
  "平和:assistant": { kSelf: 0, kFavor: 0.3 },
  "平和:third_party": { kSelf: 0.2, kFavor: 0.1 },
  "平和:self": { kSelf: 0, kFavor: 0 },

  // 喜欢
  "喜欢:assistant": { kSelf: 0, kFavor: 1.3 },
  "喜欢:third_party": { kSelf: 0.9, kFavor: 0.6 }, // doc example 3
  "喜欢:self": { kSelf: 0, kFavor: 0 },

  // 难过 — only "self" is allowed; doc example 3.
  "难过:assistant": { kSelf: 0, kFavor: -0.2 },
  "难过:third_party": { kSelf: -0.3, kFavor: -0.1 },
  "难过:self": { kSelf: -0.5, kFavor: -0.2 }, // doc example 3
};

const VALID_TYPES: readonly AttitudeType[] = [
  "愤怒",
  "满意",
  "恶意",
  "冷漠",
  "热情",
  "平和",
  "喜欢",
  "难过",
];
const VALID_TARGETS: readonly AttitudeTarget[] = [
  "assistant",
  "third_party",
  "self",
];

/** Drop items the LLM made up, malformed JSON, or items violating the
 *  "难过 only targets self / other types never target self" rule. */
export function sanitizeItems(items: unknown): AttitudeItem[] {
  if (!Array.isArray(items)) return [];
  const out: AttitudeItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<AttitudeItem>;
    const type = r.type;
    const target = r.target;
    const strength = typeof r.strength === "number" ? r.strength : NaN;
    if (!VALID_TYPES.includes(type as AttitudeType)) continue;
    if (!VALID_TARGETS.includes(target as AttitudeTarget)) continue;
    if (type !== "难过" && target === "self") continue;
    if (type === "难过" && target !== "self") continue;
    if (!Number.isFinite(strength)) continue;
    const s = Math.round(strength);
    if (s < 1 || s > 10) continue;
    out.push({
      type: type as AttitudeType,
      target: target as AttitudeTarget,
      strength: s,
    });
  }
  return out;
}

export function clampMood(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SELF_STATE;
  return Math.max(MOOD_MIN, Math.min(MOOD_MAX, Math.round(value)));
}

/** Accumulate ΔSelf / ΔFavor across all sanitized items. */
export function computeDelta(items: AttitudeItem[]): {
  deltaSelf: number;
  deltaFavor: number;
} {
  let dS = 0;
  let dF = 0;
  for (const it of items) {
    const c = COEFFICIENTS[`${it.type}:${it.target}` as CoeffKey];
    if (!c) continue;
    dS += c.kSelf * it.strength;
    dF += c.kFavor * it.strength;
  }
  return { deltaSelf: dS, deltaFavor: dF };
}

// Human-readable segment labels — fed into the prompt so the LLM reads
// "正常波动" instead of trying to interpret raw integers.
export function selfStateLabel(n: number): string {
  if (n <= 20) return "极度抑郁 / 自闭";
  if (n <= 40) return "低落 / 疲惫";
  if (n <= 70) return "正常波动";
  return "开心 / 幸福";
}

export function favorLabel(n: number): string {
  if (n <= 20) return "极度冷漠";
  if (n <= 40) return "比较冷淡";
  if (n <= 60) return "中性礼貌";
  if (n <= 80) return "偏热情";
  return "非常热情";
}
