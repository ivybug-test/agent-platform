import {
  db,
  messages,
  roomMembers,
  users,
  roomSummaries,
  userMemories,
  roomMemories,
  userRelationships,
  agentMemories,
  roomObservations,
} from "@agent-platform/db";
import {
  eq,
  and,
  inArray,
  desc,
  ne,
  isNull,
  isNotNull,
  or,
  gt,
  sql,
} from "drizzle-orm";
import { visibleToSubject } from "@/lib/memory-filters";

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

// M4.3 — long-context branch. Modern LLMs all carry 1M+ context windows
// and provider prompt caches mean repeated stable prefixes are nearly
// free. So for small rooms (most rooms), it's strictly better to dump
// the full recent history than to rely on retrieval — full recall + no
// risk of search-induced fabrication. Threshold lives behind an env var
// for easy tuning. Chinese roughly 1.5 tokens/char so 80k chars ≈ 50k-
// 80k tokens; well under all current 1M windows.
const FULL_DUMP_CHAR_THRESHOLD = Number(
  process.env.CHAT_FULL_DUMP_CHAR_THRESHOLD || 80_000
);
const FULL_DUMP_MAX_MESSAGES = Number(
  process.env.CHAT_FULL_DUMP_MAX_MESSAGES || 500
);
const FULL_DUMP_WINDOW_DAYS = 30;
const RETRIEVAL_RECENT_LIMIT = 50;

/** Load recent messages and resolve sender names.
 *
 *  Adaptive behaviour (M4.3): we first measure the room's char volume
 *  over the last 30 days. If it's under ~80k chars (most rooms), we
 *  load EVERY message in that window (capped at 500 to bound LLM cost
 *  on pathologically chatty rooms). Beyond the threshold we fall back
 *  to the recent-50-messages window and rely on retrieval (memories +
 *  observations + summary) to fill gaps.
 *
 *  Net effect: small rooms get perfect recall basically for free,
 *  large rooms behave exactly as before. */
export async function loadChatContext(roomId: string) {
  // First pass: measure volume over the rolling window. We sum
  // length(content) which is a coarse-but-fast token proxy. Streaming /
  // failed / empty rows are excluded (same predicate as the read).
  const since = new Date(
    Date.now() - FULL_DUMP_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );
  const [volRow] = await db
    .select({
      chars: sql<number>`COALESCE(SUM(LENGTH(${messages.content})), 0)`.mapWith(
        Number
      ),
      count: sql<number>`COUNT(*)`.mapWith(Number),
    })
    .from(messages)
    .where(
      and(
        eq(messages.roomId, roomId),
        eq(messages.status, "completed"),
        ne(messages.content, ""),
        // Use drizzle's gt() so the Date is bound through the column's
        // codec — passing the Date raw via sql`...` makes postgres-js
        // throw "string expected, received Date" because it never gets a
        // chance to format the value as ISO.
        gt(messages.createdAt, since)
      )
    );
  const totalChars = volRow?.chars ?? 0;
  const totalCount = volRow?.count ?? 0;

  const useFullDump =
    totalChars > 0 &&
    totalChars <= FULL_DUMP_CHAR_THRESHOLD &&
    totalCount <= FULL_DUMP_MAX_MESSAGES;

  // Second pass: actual rows.
  // - Full-dump mode: ALL rows from the 30-day window, oldest-first,
  //   no recency limit (we already proved the window fits).
  // - Retrieval mode: newest 50, then reverse to chronological.
  const rows = useFullDump
    ? await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.roomId, roomId),
            eq(messages.status, "completed"),
            ne(messages.content, ""),
            gt(messages.createdAt, since)
          )
        )
        .orderBy(messages.createdAt)
        .limit(FULL_DUMP_MAX_MESSAGES)
    : (
        await db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.roomId, roomId),
              eq(messages.status, "completed"),
              ne(messages.content, "")
            )
          )
          .orderBy(desc(messages.createdAt))
          .limit(RETRIEVAL_RECENT_LIMIT)
      ).reverse();
  const recentMessages = rows;

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

  return {
    recentMessages,
    nameMap,
    // Diagnostic flags for the caller's log line — handy to verify the
    // branch is firing as expected.
    contextMode: useFullDump ? "full-dump" : "retrieval",
    contextStats: { totalChars, totalCount },
  };
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

/** Get the room's observation log (M4.1).
 *
 * Returns the most recent N observation rows in CHRONOLOGICAL order
 * (oldest first) so they read like a time-stamped log when concatenated
 * into the prompt. We cap at 12 entries — beyond that the log starts
 * eating prompt cache budget. M4.2 will add a rolling-trim job that
 * folds old observations into longer-period parent rows (week summaries).
 */
export async function getRoomObservations(
  roomId: string,
  limit = 12
): Promise<{ content: string; periodStart: Date; periodEnd: Date }[]> {
  const rows = await db
    .select({
      content: roomObservations.content,
      periodStart: roomObservations.periodStart,
      periodEnd: roomObservations.periodEnd,
    })
    .from(roomObservations)
    .where(eq(roomObservations.roomId, roomId))
    .orderBy(desc(roomObservations.periodEnd))
    .limit(limit);
  // Newest-first from the query → reverse to oldest-first for the log.
  return rows.reverse();
}

/** Get latest room summary */
export async function getLatestSummary(
  roomId: string
): Promise<string | null> {
  const [summary] = await db
    .select()
    .from(roomSummaries)
    .where(eq(roomSummaries.roomId, roomId))
    .orderBy(desc(roomSummaries.createdAt))
    .limit(1);
  return summary?.content || null;
}

/** Pinned-memory row shape: what we hand to the prompt builder. The
 *  evidenceQuote is rendered as a short suffix so the model can see why
 *  a fact was stored (M2 anti-hallucination signal). */
export interface PinnedMemoryRow {
  category: string;
  content: string;
  kind: string;
  evidenceQuote: string | null;
}

/** Get user memories with category, ordered by dynamic memory score
 *  (strength × importance_weight × recency decay). Returns kind so the
 *  formatter can lift reflection-synthesised patterns into a dedicated
 *  prompt section instead of mixing them with raw facts. */
export async function getUserMemories(
  userId: string
): Promise<PinnedMemoryRow[]> {
  const rows = await db
    .select({
      content: userMemories.content,
      category: userMemories.category,
      kind: userMemories.kind,
      evidenceQuote: userMemories.evidenceQuote,
    })
    .from(userMemories)
    .where(and(eq(userMemories.userId, userId), visibleToSubject()))
    .orderBy(desc(MEMORY_SCORE_SQL))
    .limit(30);
  return rows;
}

// Dynamic score for agent_memories (mirrors user_memories formula).
// self_tendency benefits most from decay (they drift), so a 14-day
// half-life is shorter than user_memories' 30. world facts use 60 day
// half-life when they get added to retrieval (M4). For M3 we only inject
// persona (no decay — always-on) and self_tendency (14-day decay).
const SELF_TENDENCY_HALFLIFE_DAYS = 14;
const AGENT_SELF_TENDENCY_SCORE_SQL = sql<number>`
  ${agentMemories.strength}
  * (CASE ${agentMemories.importance}
      WHEN 'high' THEN 3
      WHEN 'medium' THEN 2
      ELSE 1
    END)
  * exp(
      -GREATEST(
        0,
        EXTRACT(EPOCH FROM (now() - COALESCE(${agentMemories.lastReinforcedAt}, ${agentMemories.updatedAt})))
      ) / (86400.0 * ${SELF_TENDENCY_HALFLIFE_DAYS})
    )
`;

export interface AgentMemoryRow {
  content: string;
  evidenceQuote: string | null;
}

export interface AgentMemoryBundle {
  persona: AgentMemoryRow[];
  selfTendency: AgentMemoryRow[];
  narrativeForUser: string | null;
  narrativeForRoom: string | null;
}

/** Load agent self-memory layers for the system prompt (M3).
 *
 * - persona: all active rows, no cap (usually <10; user maintains them)
 * - self_tendency: top 3 by dynamic score (strength × importance × decay)
 * - narrative for current user: most recent active narrative row
 * - narrative for current room: most recent active narrative row
 *
 * `world` kind is NOT pinned — it lands in retrieval (M4+) so it's
 * fetched by semantic similarity to the current turn, not always-on.
 */
export async function getAgentMemories(
  agentId: string,
  currentUserId: string,
  currentRoomId: string
): Promise<AgentMemoryBundle> {
  // Persona: all active, no decay, no cap (small set by design)
  const personaP = db
    .select({
      content: agentMemories.content,
      evidenceQuote: agentMemories.evidenceQuote,
    })
    .from(agentMemories)
    .where(
      and(
        eq(agentMemories.agentId, agentId),
        eq(agentMemories.kind, "persona"),
        isNull(agentMemories.deletedAt)
      )
    )
    .orderBy(desc(agentMemories.importance), desc(agentMemories.updatedAt))
    .limit(20);

  // self_tendency: top 3 by dynamic score
  const selfTendencyP = db
    .select({
      content: agentMemories.content,
      evidenceQuote: agentMemories.evidenceQuote,
    })
    .from(agentMemories)
    .where(
      and(
        eq(agentMemories.agentId, agentId),
        eq(agentMemories.kind, "self_tendency"),
        isNull(agentMemories.deletedAt)
      )
    )
    .orderBy(desc(AGENT_SELF_TENDENCY_SCORE_SQL))
    .limit(3);

  // Narrative for (agent, user): one row, latest by updated_at
  const narrativeUserP = db
    .select({ content: agentMemories.content })
    .from(agentMemories)
    .where(
      and(
        eq(agentMemories.agentId, agentId),
        eq(agentMemories.kind, "narrative"),
        eq(agentMemories.scopeUserId, currentUserId),
        isNull(agentMemories.deletedAt)
      )
    )
    .orderBy(desc(agentMemories.updatedAt))
    .limit(1);

  // Narrative for (agent, room): one row, latest by updated_at
  const narrativeRoomP = db
    .select({ content: agentMemories.content })
    .from(agentMemories)
    .where(
      and(
        eq(agentMemories.agentId, agentId),
        eq(agentMemories.kind, "narrative"),
        eq(agentMemories.scopeRoomId, currentRoomId),
        isNull(agentMemories.deletedAt)
      )
    )
    .orderBy(desc(agentMemories.updatedAt))
    .limit(1);

  const [persona, selfTendency, narrativeUser, narrativeRoom] =
    await Promise.all([personaP, selfTendencyP, narrativeUserP, narrativeRoomP]);

  return {
    persona,
    selfTendency,
    narrativeForUser: narrativeUser[0]?.content ?? null,
    narrativeForRoom: narrativeRoom[0]?.content ?? null,
  };
}

/** Get memories for all users in a room */
export async function getRoomUsersMemories(
  roomId: string
): Promise<Map<string, PinnedMemoryRow[]>> {
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
  // Identity + high-importance + ALL reflections (they're already cluster-
  // size-gated to ≥3 events so noise is low and they're the most useful
  // signal for "what's this person consistently like" — exactly what
  // pinned context should carry).
  const allMemories = await db
    .select({
      userId: userMemories.userId,
      content: userMemories.content,
      category: userMemories.category,
      kind: userMemories.kind,
      evidenceQuote: userMemories.evidenceQuote,
    })
    .from(userMemories)
    .where(
      and(
        inArray(userMemories.userId, memberIds),
        visibleToSubject(),
        or(
          eq(userMemories.category, "identity"),
          eq(userMemories.importance, "high"),
          eq(userMemories.kind, "reflection")
        )
      )
    )
    .orderBy(desc(MEMORY_SCORE_SQL));

  // Group by user name, cap per-user to keep context bounded
  const result = new Map<string, PinnedMemoryRow[]>();
  const countPerUser = new Map<string, number>();

  for (const m of allMemories) {
    const name = idToName.get(m.userId);
    if (!name) continue;
    const count = countPerUser.get(m.userId) || 0;
    if (count >= 8) continue;
    countPerUser.set(m.userId, count + 1);
    const list = result.get(name) || [];
    list.push({
      category: m.category,
      kind: m.kind,
      content: m.content,
      evidenceQuote: m.evidenceQuote,
    });
    result.set(name, list);
  }

  return result;
}
