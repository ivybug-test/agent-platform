export const VALID_CATEGORIES = [
  "identity",
  "preference",
  "relationship",
  "event",
  "opinion",
  "context",
] as const;
export const VALID_IMPORTANCES = ["high", "medium", "low"] as const;

export const VALID_RELATIONSHIP_KINDS = [
  "spouse",
  "family",
  "colleague",
  "friend",
  "custom",
] as const;

export type Category = (typeof VALID_CATEGORIES)[number];
export type Importance = (typeof VALID_IMPORTANCES)[number];
export type RelationshipKind = (typeof VALID_RELATIONSHIP_KINDS)[number];

// Phase A: on a near-duplicate, REINFORCE the existing memory (bump strength +
// last_reinforced_at) instead of skipping silently. The threshold name stays
// the same to avoid churn; the action is different.
export const SIMILARITY_SKIP_THRESHOLD = 0.55;

export function clampLimit(n: unknown, dflt: number, max: number): number {
  const v = typeof n === "number" ? Math.floor(n) : dflt;
  if (!Number.isFinite(v) || v <= 0) return dflt;
  return Math.min(v, max);
}

/** Escape LIKE/ILIKE wildcard chars so user input doesn't pattern-glob. */
export function esc(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

/** Accepts "YYYY-MM-DD", "YYYY-MM-DDTHH:mm", or a full ISO string. Bare dates
 *  anchor to Asia/Shanghai noon so timezone drift doesn't push them off-day. */
export function parseEventAt(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T04:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
