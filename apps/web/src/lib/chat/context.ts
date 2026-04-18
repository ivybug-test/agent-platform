import { db, messages, roomMembers, users, roomSummaries, userMemories } from "@agent-platform/db";
import { eq, and, inArray, desc, ne, isNull, or } from "drizzle-orm";
import { createLogger } from "@agent-platform/logger";

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

/** Get user memories with category, ordered by importance then recency */
export async function getUserMemories(
  userId: string
): Promise<{ category: string; content: string }[]> {
  const rows = await db
    .select({
      content: userMemories.content,
      category: userMemories.category,
    })
    .from(userMemories)
    .where(and(eq(userMemories.userId, userId), isNull(userMemories.deletedAt)))
    .orderBy(desc(userMemories.importance), desc(userMemories.updatedAt))
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
        isNull(userMemories.deletedAt),
        or(
          eq(userMemories.category, "identity"),
          eq(userMemories.importance, "high")
        )
      )
    )
    .orderBy(desc(userMemories.importance), desc(userMemories.updatedAt));

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

/** Build the 6-layer system prompt (per CLAUDE.md context strategy) */
export function buildSystemPrompt(opts: {
  agentPrompt: string | null;
  roomPrompt: string | null;
  roomName: string;
  memberNames: string[];
  agentName: string;
  currentUserName: string;
  roomSummary: string | null;
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
- search_memories: look up facts about the current user beyond the pinned list above — preferences, relationships, past events, opinions, current context. Call this BEFORE claiming you don't know something.
- search_messages: find something said earlier in this room that is outside the recent window shown below.
- remember: save a new lasting fact about the user. Only for cross-session information (identity, strong preferences, relationships, significant events, values, ongoing projects). NEVER for trivia, questions to you, emotional remarks, or chit-chat. The tool auto-skips near-duplicates.
- update_memory: call ONLY when the user explicitly corrects a fact ("actually it's X", "I moved", "no, not Y"). Pass the id from search_memories.
- forget_memory: call ONLY when the user explicitly asks to forget something ("don't remember X", "stop tracking Y"). Pass the id from search_memories.

LANGUAGE: When writing memory content (via remember / update_memory), write in the SAME LANGUAGE the user is using in the conversation. If the user writes in Chinese, store the fact in Chinese (e.g. "喜欢吃辣"). Do NOT translate.

MEMORY WRITING RULES IN GROUP CONVERSATIONS (STRICT):
- You MUST only call remember / update_memory / forget_memory for the current speaker (${opts.currentUserName}). Never for another room member.
- If ${opts.currentUserName} describes another person (e.g. "B likes sweets" or "帮我记住 Bob 喜欢甜食"), DO NOT call any memory tool. You may acknowledge the information in your reply, but memory-writing for that other person has to wait until they themselves speak in the room.
- search_memories is already scoped to the current speaker. Do not attempt to query other members' memories — the tool will return nothing useful.

Prefer not calling a tool if your current context is already sufficient.`;

  return [
    // Layer 1: Agent identity (system prompt)
    opts.agentPrompt || "You are a helpful assistant.",
    // Layer 2: Room rules (room system_prompt)
    [
      opts.roomPrompt,
      `Room: "${opts.roomName}". Members: ${opts.memberNames.join(", ")}.`,
    ]
      .filter(Boolean)
      .join("\n"),
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
