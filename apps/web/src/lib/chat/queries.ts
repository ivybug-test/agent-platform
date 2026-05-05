import {
  db,
  messages,
  roomMembers,
  users,
  roomSummaries,
  userMemories,
  roomMemories,
  userRelationships,
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

/** Load recent messages and resolve sender names */
export async function loadChatContext(roomId: string) {
  // Get newest 50 completed messages (subquery: order DESC limit, then reverse)
  const newest = await db
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
