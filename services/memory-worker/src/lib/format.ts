export const VALID_CATEGORIES = [
  "identity",
  "preference",
  "relationship",
  "event",
  "opinion",
  "context",
];
export const VALID_IMPORTANCES = ["high", "medium", "low"];

/** Render a message's body for the extraction prompt. Image messages use
 *  the captured caption when present so user_memories can be extracted from
 *  what the user actually showed (e.g. "this is my dog Max" + photo →
 *  "user has a dog named Max"). */
export function messageBody(m: {
  content: string;
  contentType: string;
  metadata: unknown;
}): string {
  if (m.contentType !== "image") return m.content;
  const cap =
    (m.metadata as { vision?: { caption?: string } } | null)?.vision?.caption;
  return cap ? `[image: ${cap}]` : "[image: (caption pending)]";
}

/** Detect language of text: if >30% characters are CJK, call it Chinese. */
export function detectLanguage(text: string): string {
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const total = text.replace(/\s/g, "").length;
  return total > 0 && cjk / total > 0.3 ? "Chinese" : "English";
}

/** Format a Date as "YYYY-MM-DD HH:mm" in Asia/Shanghai — matches the extraction
 *  prompt rule that relative time phrases resolve against the user's wall clock. */
export function formatWallClock(d: Date): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get(
    "minute"
  )}`;
}

/** Parse an LLM-supplied eventAt string (date or datetime) into a Date, or
 *  return null if it's missing/invalid. Accepts "2026-04-19", "2026-04-19T12:30",
 *  or full ISO. Bare date strings anchor to Asia/Shanghai noon so timezone drift
 *  doesn't push them onto the prior day in UTC storage. */
export function parseEventAt(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // Date-only: anchor to Asia/Shanghai 12:00 → 04:00 UTC
    const d = new Date(`${s}T04:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function formatMemoriesByCategory(
  memories: { id: string; content: string; category: string }[],
  lockedIds: Set<string>,
  pendingIds: Set<string>
): string {
  const groups = new Map<
    string,
    { id: string; content: string; locked: boolean; pending: boolean }[]
  >();
  for (const m of memories) {
    const list = groups.get(m.category) || [];
    list.push({
      id: m.id,
      content: m.content,
      locked: lockedIds.has(m.id),
      pending: pendingIds.has(m.id),
    });
    groups.set(m.category, list);
  }

  if (groups.size === 0) return "(no existing memories)";

  const sections: string[] = [];
  for (const cat of VALID_CATEGORIES) {
    const items = groups.get(cat);
    if (items && items.length > 0) {
      sections.push(
        `[${cat}]\n${items
          .map((m) => {
            const tags = [
              m.locked ? "[LOCKED]" : "",
              m.pending ? "[PENDING]" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return `- ${tags ? tags + " " : ""}(id: ${m.id}) ${m.content}`;
          })
          .join("\n")}`
      );
    }
  }
  return sections.join("\n\n");
}
