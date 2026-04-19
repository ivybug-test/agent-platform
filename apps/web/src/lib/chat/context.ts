import { db, messages, roomMembers, users, roomSummaries, userMemories, roomMemories, userRelationships } from "@agent-platform/db";
import { eq, and, inArray, desc, ne, isNull, isNotNull, or, sql } from "drizzle-orm";
import { visibleToSubject } from "@/lib/memory-filters";
import { createLogger } from "@agent-platform/logger";

// Dynamic memory score (Phase A). Mirrors the Generative-Agents formula:
// effective = strength × importance_weight × exp(-age_days / HALF_LIFE).
// Rows whose last reinforcement was long ago decay toward zero; frequent
// mentions (strength > 1) hold their place. identity / high-importance rows
// get higher baseline weight so they still dominate the pinned window.
const DECAY_HALFLIFE_DAYS = 30;
const MEMORY_SCORE_SQL = sql<number>`
  ${userMemories.strength}
  * (CASE ${userMemories.importance}
      WHEN 'high' THEN 3
      WHEN 'medium' THEN 2
      ELSE 1
    END)
  * exp(
      -GREATEST(
        0,
        EXTRACT(EPOCH FROM (now() - COALESCE(${userMemories.lastReinforcedAt}, ${userMemories.updatedAt})))
      ) / (86400.0 * ${DECAY_HALFLIFE_DAYS})
    )
`;

const log = createLogger("web");

/** Load recent messages and resolve sender names */
export async function loadChatContext(roomId: string) {
  // Get newest 50 completed messages (subquery: order DESC limit, then reverse)
  const newest = await db
    .select()
    .from(messages)
    .where(and(eq(messages.roomId, roomId), eq(messages.status, "completed"), ne(messages.content, "")))
    .orderBy(desc(messages.createdAt))
    .limit(50);
  const recentMessages = newest.reverse();

  // Resolve sender names
  const senderIds = [
    ...new Set(
      recentMessages
        .filter((m) => m.senderType === "user" && m.senderId)
        .map((m) => m.senderId!)
    ),
  ];
  const senderUsers =
    senderIds.length > 0
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, senderIds))
      : [];
  const nameMap = new Map(senderUsers.map((u) => [u.id, u.name]));

  return { recentMessages, nameMap };
}

/** Get all user member names in a room */
export async function getRoomMemberNames(roomId: string): Promise<string[]> {
  const memberRows = await db
    .select({ memberId: roomMembers.memberId })
    .from(roomMembers)
    .where(
      and(eq(roomMembers.roomId, roomId), eq(roomMembers.memberType, "user"))
    );
  const memberIds = memberRows.map((m) => m.memberId);
  if (memberIds.length === 0) return [];

  const memberUsers = await db
    .select({ name: users.name })
    .from(users)
    .where(inArray(users.id, memberIds));
  return memberUsers.map((u) => u.name);
}

/**
 * Active, both-sides-confirmed relationships that involve `userId` and land
 * among the room's members. Formatted with the OTHER party's display name.
 * Phase 4.
 */
export async function getConfirmedRelationshipsForUser(
  userId: string,
  roomMemberIds: string[]
): Promise<{ otherName: string; kind: string; content: string | null }[]> {
  if (roomMemberIds.length === 0) return [];
  const rows = await db
    .select({
      aUserId: userRelationships.aUserId,
      bUserId: userRelationships.bUserId,
      kind: userRelationships.kind,
      content: userRelationships.content,
    })
    .from(userRelationships)
    .where(
      and(
        isNull(userRelationships.deletedAt),
        isNotNull(userRelationships.confirmedByA),
        isNotNull(userRelationships.confirmedByB),
        or(
          eq(userRelationships.aUserId, userId),
          eq(userRelationships.bUserId, userId)
        )
      )
    );

  // Only keep rows where the other side is also present in this room.
  const memberSet = new Set(roomMemberIds);
  const filtered = rows.filter((r) => {
    const other = r.aUserId === userId ? r.bUserId : r.aUserId;
    return memberSet.has(other);
  });
  if (filtered.length === 0) return [];

  const otherIds = [
    ...new Set(
      filtered.map((r) => (r.aUserId === userId ? r.bUserId : r.aUserId))
    ),
  ];
  const nameRows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, otherIds));
  const nameMap = new Map(nameRows.map((u) => [u.id, u.name]));

  return filtered.map((r) => ({
    otherName:
      nameMap.get(r.aUserId === userId ? r.bUserId : r.aUserId) || "?",
    kind: r.kind,
    content: r.content,
  }));
}

/** Get active room memories ordered by importance + recency (Phase 3). */
export async function getRoomMemories(
  roomId: string
): Promise<{ content: string; importance: string }[]> {
  const rows = await db
    .select({
      content: roomMemories.content,
      importance: roomMemories.importance,
    })
    .from(roomMemories)
    .where(and(eq(roomMemories.roomId, roomId), isNull(roomMemories.deletedAt)))
    .orderBy(desc(roomMemories.importance), desc(roomMemories.updatedAt))
    .limit(10);
  return rows;
}

/** Get latest room summary */
export async function getLatestSummary(roomId: string): Promise<string | null> {
  const [summary] = await db
    .select()
    .from(roomSummaries)
    .where(eq(roomSummaries.roomId, roomId))
    .orderBy(desc(roomSummaries.createdAt))
    .limit(1);
  return summary?.content || null;
}

/** Get user memories with category, ordered by dynamic memory score
 *  (strength × importance_weight × recency decay). */
export async function getUserMemories(
  userId: string
): Promise<{ category: string; content: string }[]> {
  const rows = await db
    .select({
      content: userMemories.content,
      category: userMemories.category,
    })
    .from(userMemories)
    .where(and(eq(userMemories.userId, userId), visibleToSubject()))
    .orderBy(desc(MEMORY_SCORE_SQL))
    .limit(30);
  return rows;
}

/** Get memories for all users in a room */
export async function getRoomUsersMemories(
  roomId: string
): Promise<Map<string, { category: string; content: string }[]>> {
  // Get all user members in this room
  const memberRows = await db
    .select({ memberId: roomMembers.memberId })
    .from(roomMembers)
    .where(
      and(eq(roomMembers.roomId, roomId), eq(roomMembers.memberType, "user"))
    );
  const memberIds = memberRows.map((m) => m.memberId);
  if (memberIds.length === 0) return new Map();

  // Get names
  const memberUsers = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, memberIds));
  const idToName = new Map(memberUsers.map((u) => [u.id, u.name]));

  // Always-on memory policy (C2): inject only identity facts and high-importance
  // memories. Everything else is retrievable on-demand through the search_memories
  // tool so the prompt stays lean while the agent can still pull details when
  // they matter.
  //
  // Multi-user (Phase 2): visibleToSubject() filters out both tombstones and
  // unconfirmed third-party writes.
  const allMemories = await db
    .select({
      userId: userMemories.userId,
      content: userMemories.content,
      category: userMemories.category,
    })
    .from(userMemories)
    .where(
      and(
        inArray(userMemories.userId, memberIds),
        visibleToSubject(),
        or(
          eq(userMemories.category, "identity"),
          eq(userMemories.importance, "high")
        )
      )
    )
    .orderBy(desc(MEMORY_SCORE_SQL));

  // Group by user name, cap per-user to keep context bounded
  const result = new Map<string, { category: string; content: string }[]>();
  const countPerUser = new Map<string, number>();

  for (const m of allMemories) {
    const name = idToName.get(m.userId);
    if (!name) continue;
    const count = countPerUser.get(m.userId) || 0;
    if (count >= 8) continue;
    countPerUser.set(m.userId, count + 1);

    const list = result.get(name) || [];
    list.push({ category: m.category, content: m.content });
    result.set(name, list);
  }

  return result;
}

const CATEGORY_LABELS: Record<string, string> = {
  identity: "Who they are",
  preference: "Preferences",
  relationship: "People they know",
  event: "Key events",
  opinion: "Views & opinions",
  context: "Current context",
};

/** Format memories for a single user, grouped by category */
function formatUserMemories(
  memories: { category: string; content: string }[]
): string {
  const grouped = new Map<string, string[]>();
  for (const m of memories) {
    const list = grouped.get(m.category) || [];
    list.push(m.content);
    grouped.set(m.category, list);
  }

  const sections: string[] = [];
  for (const [cat, label] of Object.entries(CATEGORY_LABELS)) {
    const items = grouped.get(cat);
    if (items && items.length > 0) {
      sections.push(`${label}:\n${items.map((i) => `- ${i}`).join("\n")}`);
    }
  }
  return sections.join("\n");
}

/** Format current wall-clock time for injection into the system prompt. */
function formatCurrentTime(now: Date = new Date()): string {
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

/** Build the 6-layer system prompt (per CLAUDE.md context strategy) */
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

  const toolGuidance = `TOOLS YOU CAN CALL (optional, use only when genuinely useful):
- search_memories: look up facts about the current user beyond the pinned list above — preferences, relationships, past events, opinions, current context. Call this BEFORE claiming you don't know something. To look up what happened in a specific time window, pass ISO8601 "from"/"to" (e.g. {from:"2026-04-12T00:00:00+08:00", to:"2026-04-19T00:00:00+08:00"}) — this filters on the fact's event_at.
- search_messages: find something said earlier in this room that is outside the recent window shown below. Supports "before" / "after" ISO timestamps.
- remember: save a new lasting fact about the user. Only for cross-session information (identity, strong preferences, relationships, significant events, values, ongoing projects). NEVER for trivia, questions to you, emotional remarks, or chit-chat. If the fact describes a specific event in time (e.g. "went to Shanghai on 2026-04-14", "skipped lunch on 2026-04-19"), also pass eventAt as an ISO8601 timestamp. Do NOT record relative phrases like "今天" / "刚才" — always resolve them to an absolute date using the current time layer above. Near-duplicates reinforce the existing memory instead of creating a new one.
- update_memory: call ONLY when the user explicitly corrects a fact ("actually it's X", "I moved", "no, not Y"). Pass the id from search_memories.
- forget_memory: call ONLY when the user explicitly asks to forget something ("don't remember X", "stop tracking Y"). Pass the id from search_memories.

LANGUAGE: When writing memory content (via remember / update_memory), write in the SAME LANGUAGE the user is using in the conversation. If the user writes in Chinese, store the fact in Chinese (e.g. "喜欢吃辣"). Do NOT translate.

MEMORY WRITING IN GROUP CONVERSATIONS:
- The default subject of remember / update_memory / forget_memory is the current speaker (${opts.currentUserName}).
- If you decide a fact is genuinely about another room member and worth storing across sessions, call remember with subjectName set to that member's name. The write lands in a pending queue; the subject will see it in their /memories "待确认" tab and can accept or reject it. Prefer NOT doing this unless the fact is both specific and clearly useful — casual descriptions of others should just be acknowledged in your reply.
- update_memory and forget_memory can only touch the current speaker's own memories (rows the tool returns as editable). Don't try to edit other members' rows.
- search_memories is already scoped to the current speaker. Other members' memories are not retrievable here.

Prefer not calling a tool if your current context is already sufficient.`;

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
    // Layer 1b: Wall-clock anchor for resolving relative time phrases
    nowLine,
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
    toolGuidance,
    // Layer 6: User context + rules
    `IMPORTANT RULES:
1. The message you are replying to was sent by: ${opts.currentUserName}. Respond ONLY to ${opts.currentUserName}'s latest message. Do NOT confuse them with other users.
2. Each user message is prefixed with their name (e.g. "binqiu: hello"). ALWAYS check the name prefix to identify who is speaking. Different names = different people with different personalities and memories.
3. Do NOT repeat yourself. Before replying, review your recent responses above. If you already said something similar, say something new and different.
4. You are ${opts.agentName}. Never pretend to be a user. Never prefix your reply with a name.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Compute similarity between two strings using character-level bigrams.
 * Works for CJK text (no word boundaries) and English alike.
 * Returns 0-1, where 1 means identical bigram sets.
 */
function textSimilarity(a: string, b: string): number {
  const bigrams = (s: string): Map<string, number> => {
    const chars = [...s.replace(/\s+/g, "")]; // spread handles CJK correctly
    const map = new Map<string, number>();
    for (let i = 0; i < chars.length - 1; i++) {
      const bg = chars[i] + chars[i + 1];
      map.set(bg, (map.get(bg) || 0) + 1);
    }
    return map;
  };
  const bgA = bigrams(a);
  const bgB = bigrams(b);
  let intersection = 0;
  let union = 0;
  const allKeys = new Set([...bgA.keys(), ...bgB.keys()]);
  for (const k of allKeys) {
    const ca = bgA.get(k) || 0;
    const cb = bgB.get(k) || 0;
    intersection += Math.min(ca, cb);
    union += Math.max(ca, cb);
  }
  return union === 0 ? 0 : intersection / union;
}

/**
 * Deduplicate context messages: when multiple agent responses are highly similar,
 * keep only the most recent one. This prevents the LLM from seeing repetitive
 * context and producing repetitive output.
 */
function deduplicateContext(
  msgs: { senderType: string; senderId: string | null; content: string }[]
): { senderType: string; senderId: string | null; content: string }[] {
  // Collect all agent message contents (with index) for similarity checking
  const agentEntries = msgs
    .map((m, i) => ({ index: i, content: m.content }))
    .filter((_, i) => msgs[i].senderType === "agent");

  // Find agent messages that are too similar to a LATER agent message
  const skipIndices = new Set<number>();
  for (let i = 0; i < agentEntries.length; i++) {
    for (let j = i + 1; j < agentEntries.length; j++) {
      if (textSimilarity(agentEntries[i].content, agentEntries[j].content) > 0.4) {
        // Keep the later one (j), mark the earlier one (i) for removal
        skipIndices.add(agentEntries[i].index);
        break;
      }
    }
  }

  // Also skip the user message right before a skipped agent message
  // (to keep user→agent pairs coherent)
  const skipWithContext = new Set<number>();
  for (const idx of skipIndices) {
    skipWithContext.add(idx);
    if (idx > 0 && msgs[idx - 1].senderType === "user") {
      skipWithContext.add(idx - 1);
    }
  }

  const result = msgs.filter((_, i) => !skipWithContext.has(i));
  if (skipIndices.size > 0) {
    log.info({ before: msgs.length, after: result.length, removedAgent: skipIndices.size }, "context.dedup");
  }
  return result;
}

/** Build messages array for LLM */
export function buildLLMMessages(
  systemContent: string,
  recentMessages: { senderType: string; senderId: string | null; content: string }[],
  nameMap: Map<string, string>
) {
  const filtered = deduplicateContext(recentMessages);

  return [
    { role: "system" as const, content: systemContent },
    ...filtered.map((m) => {
      if (m.senderType === "user") {
        const name = m.senderId ? nameMap.get(m.senderId) || "User" : "User";
        return { role: "user" as const, content: `${name}: ${m.content}` };
      }
      return { role: "assistant" as const, content: m.content };
    }),
  ];
}
