const CATEGORY_LABELS: Record<string, string> = {
  identity: "Who they are",
  preference: "Preferences",
  relationship: "People they know",
  event: "Key events",
  opinion: "Views & opinions",
  context: "Current context",
};

// Evidence quotes get clipped before injection so a single fact can't
// blow out the prompt. 60 chars is enough to see WHY a fact was stored
// without flooding the model with the full message.
const MAX_EVIDENCE_DISPLAY_LEN = 60;

function formatEvidence(quote: string | null | undefined): string {
  if (!quote) return "";
  const trimmed = quote.trim();
  if (!trimmed) return "";
  const clipped =
    trimmed.length > MAX_EVIDENCE_DISPLAY_LEN
      ? trimmed.slice(0, MAX_EVIDENCE_DISPLAY_LEN) + "…"
      : trimmed;
  // Escape any double quotes inside the clip so the suffix stays parseable.
  return ` [evidence: "${clipped.replace(/"/g, '\\"')}"]`;
}

/** Format memories for a single user, grouped by category. M2: every
 *  fact carries an `[evidence: "..."]` suffix when we have a stored
 *  evidence quote. This both signals to the LLM that the fact is
 *  grounded AND lets it cite the underlying user wording when asked.
 *
 *  Reflection v1: kind='reflection' rows are lifted into a dedicated
 *  "Recurring patterns" section above the category buckets — these are
 *  the high-order patterns the offline reflection job synthesised, and
 *  they should stand out from atomic facts. */
export function formatUserMemories(
  memories: {
    category: string;
    kind?: string;
    content: string;
    evidenceQuote?: string | null;
  }[]
): string {
  const patterns: { content: string; evidenceQuote: string | null }[] = [];
  const grouped = new Map<
    string,
    { content: string; evidenceQuote: string | null }[]
  >();

  for (const m of memories) {
    const item = { content: m.content, evidenceQuote: m.evidenceQuote ?? null };
    if (m.kind === "reflection") {
      patterns.push(item);
      continue;
    }
    const list = grouped.get(m.category) || [];
    list.push(item);
    grouped.set(m.category, list);
  }

  const sections: string[] = [];

  // Patterns first — they describe stable traits/behaviour the user
  // exhibits across many events, more useful for grounding the agent's
  // long-arc understanding than any single event row would be.
  if (patterns.length > 0) {
    sections.push(
      `Recurring patterns:\n${patterns
        .map((p) => `- ${p.content}${formatEvidence(p.evidenceQuote)}`)
        .join("\n")}`
    );
  }

  for (const [cat, label] of Object.entries(CATEGORY_LABELS)) {
    const items = grouped.get(cat);
    if (items && items.length > 0) {
      sections.push(
        `${label}:\n${items
          .map((i) => `- ${i.content}${formatEvidence(i.evidenceQuote)}`)
          .join("\n")}`
      );
    }
  }
  return sections.join("\n");
}

/** Format agent self-memory layers (M3) into a single Layer-0 block.
 *  Order: persona → self_tendency → narrative-with-user → narrative-with-room.
 *  Empty sections are dropped. Returns null when there's nothing to inject
 *  so the caller doesn't add a stray empty layer. */
export function formatAgentMemories(opts: {
  agentName: string;
  currentUserName: string;
  roomName: string;
  persona: { content: string; evidenceQuote: string | null }[];
  selfTendency: { content: string; evidenceQuote: string | null }[];
  narrativeForUser: string | null;
  narrativeForRoom: string | null;
}): string | null {
  const sections: string[] = [];

  if (opts.persona.length > 0) {
    sections.push(
      `Persona (who you, ${opts.agentName}, are):\n${opts.persona
        .map((p) => `- ${p.content}${formatEvidence(p.evidenceQuote)}`)
        .join("\n")}`
    );
  }
  if (opts.selfTendency.length > 0) {
    sections.push(
      `Habits you've noticed about yourself:\n${opts.selfTendency
        .map((p) => `- ${p.content}${formatEvidence(p.evidenceQuote)}`)
        .join("\n")}`
    );
  }
  if (opts.narrativeForUser) {
    sections.push(
      `Your history with ${opts.currentUserName}:\n${opts.narrativeForUser}`
    );
  }
  if (opts.narrativeForRoom) {
    sections.push(
      `Your sense of this room ("${opts.roomName}"):\n${opts.narrativeForRoom}`
    );
  }
  if (sections.length === 0) return null;
  return `[About yourself]\n\n${sections.join("\n\n")}`;
}

/** Format the observation log (M4.1) into a prompt-cache-friendly block.
 *  Observations come in chronological order — we render them as a
 *  single time-ordered log with a brief preamble so the LLM treats it
 *  as factual history, not as a list of opinions. */
export function formatObservations(
  observations: { content: string; periodStart: Date; periodEnd: Date }[]
): string | null {
  if (observations.length === 0) return null;
  // We don't need to render period boundaries — the LLM produced each
  // observation block with absolute timestamps inside the lines, which
  // is what the agent will actually use.
  const body = observations.map((o) => o.content).join("\n\n");
  return `Conversation history (observation log — each line is a real event with absolute time, oldest at top):\n\n${body}`;
}

/** Compact "YYYY-MM-DD HH:mm" in Asia/Shanghai — used as the per-message
 *  timestamp prefix so the agent sees when each recent message was sent. */
export function formatShortWallClock(d: Date): string {
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

/** Format current wall-clock time for injection into the system prompt. */
export function formatCurrentTime(now: Date = new Date()): string {
  // Render in Asia/Shanghai — this is a CN-user product and the LLM handling
  // relative phrases like "今天" / "昨天" must resolve them against the user's
  // wall clock, not UTC. If multi-TZ support is added later, thread a tz in.
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get(
    "minute"
  )} ${get("weekday")} (Asia/Shanghai)`;
}
