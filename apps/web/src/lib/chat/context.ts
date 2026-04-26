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

/** Compact "YYYY-MM-DD HH:mm" in Asia/Shanghai — used as the per-message
 *  timestamp prefix so the agent sees when each recent message was sent. */
function formatShortWallClock(d: Date): string {
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
- search_messages: find something said earlier in this room. **CALL THIS PROACTIVELY** any time the user asks about past room conversation ("上次", "之前", "那天", "还记得", "你说过", "聊过", "earlier", "remember when") — even if you think you remember, even if it might be in the recent window. The tool reads the WHOLE room history (not just the recent ~50-msg window above). Each result has an id; cite the most-relevant 1-2 via '[查看原文](msg:<id>)' in your reply. See rule #9 for the full anti-fabrication policy. Supports "before" / "after" ISO timestamps for time-windowed search.
- remember: save a new lasting fact about the user. Only for cross-session information (identity, strong preferences, relationships, significant events, values, ongoing projects). NEVER for trivia, questions to you, emotional remarks, or chit-chat. If the fact describes a specific event in time (e.g. "went to Shanghai on 2026-04-14", "skipped lunch on 2026-04-19"), also pass eventAt as an ISO8601 timestamp. Do NOT record relative phrases like "今天" / "刚才" — always resolve them to an absolute date using the current time layer above. Near-duplicates reinforce the existing memory instead of creating a new one.
- update_memory: call ONLY when the user explicitly corrects a fact ("actually it's X", "I moved", "no, not Y"). Pass the id from search_memories.
- forget_memory: call ONLY when the user explicitly asks to forget something ("don't remember X", "stop tracking Y"). Pass the id from search_memories.
- web_search: search the live web. **Use this PROACTIVELY before answering** any question about: a specific date / version / release ("X 什么时候发布"), a specific product or company ("X 公司怎么样"), prices, recent news, current events, weather, sports scores, anything time-bounded, anything where the user's question implies they want a verified answer rather than your guess. If you find yourself about to type a specific number, date, version string, or factual claim that you can't 100% recall — search first. Hallucinating a wrong release date is worse than spending a second on a search. Do NOT preface with "据我所知" / "我记得" — search and cite. Cap 5 results. **You MUST cite the source URL inline (markdown "[标题](url)") for every concrete fact you take from a search result. If a claim isn't supported by a returned snippet, drop it. If search returned nothing useful, say so — never fall back to hallucinated knowledge.**
- search_lyrics: when the user asks you to sing or quote a SPECIFIC song (they say "晴天" / "夜曲" by name), call this BEFORE composing the reply. Returns 5 links: typically a QQ 音乐 / 酷狗 streaming page (the frontend auto-renders these as a song card with cover art) plus a few third-party lyrics sites (mtv123 / kugeci / etc). The streaming-page snippets do NOT contain actual lyric text (QQ 音乐 is a SPA, Bocha can't see inside). If you need lyric TEXT to quote a verse, follow up with fetch_url on one of the third-party static lyrics URLs from the same result set — don't give up just because the first QQ 音乐 snippet has no lyrics.
- search_music: browse-y music search scoped to QQ 音乐 / 网易云. Use when the user asks for an artist's catalog ("周杰伦的歌"), recommendations ("适合通勤听的歌"), new releases, albums, or anything music-related WITHOUT a specific song name. Don't fall back to web_search for music queries — search_music's site filter is much more useful.
- fetch_url: read the full content of a webpage. Call this ONLY when (a) the USER pasted a URL into chat (e.g. "看下这个 https://..."), or (b) you just called search_lyrics and need the actual lyric text from a third-party static lyrics page. DO NOT call fetch_url on URLs from generic web_search — the snippet is enough there. Returns ~8000 chars of cleaned page text.
- read_image: look at an image the user posted in this room. Pass the messageId from the inline '[图片#N (msgId=xxx)]' marker. Returns a text caption of what the image shows. Call this ONLY when the user's current message references the image and answering needs to know its contents. Don't call it for images from earlier turns the user has moved on from. If the response is { caption: null, status: "processing" } the async caption pipeline hasn't finished yet — tell the user to wait a moment, don't fabricate.
- generate_image: draw / paint an image. **CALL THE TOOL FIRST, THEN write text** — the tool call MUST come BEFORE you compose the text reply. The tool is async and returns immediately with { messageId, queued: true }; the placeholder image bubble auto-swaps to the real image ~20s later. Triggers: (a) explicit draw (画一张 / 画一个 / 画 X / draw); (b) requests to see (给我看 / 给我看看 / 让我看看 / show me X); (c) implied creation (X 长什么样 / X 的画面); (d) image-to-image / edit (把这张图改成 X / 改成 X 风格 / 加点 X / 这两张融合) — pass the source's msgId in referenceMessageIds (1-4, all from this room's [图片#N (msgId=...)] markers); (e) variation / redo — '再画一张' / '再来一张' / '换个风格' — call AGAIN, don't just acknowledge. After a successful tool_call your text can briefly comment ("好嘞，调整一下" / "用 X 风格再画一张") — but writing '画着呢' / '稍等十几秒' / '马上来' WITHOUT having emitted a tool_call this turn is a forbidden hallucination (see rule #10). REMEMBER the messageId you got back; if the user says '停 / 别画了 / 取消 / cancel', call cancel_image_generation(messageId). One generate_image call per request.
- cancel_image_generation: abort an in-flight generate_image you started earlier in THIS conversation. Triggers: '停 / 停一下 / 别画了 / 不要了 / 取消 / 不画了 / stop / cancel / abort'. Pass the messageId you got back from the prior generate_image tool result. Returns { ok: true } on successful abort, { ok: false, reason } if the gen has already finished / failed / wasn't found. Don't call preemptively — only when the user explicitly asks to stop.
- speak: attach a spoken/audio version to this reply. **CALL THE TOOL FIRST, THEN write text** — the speak tool_call MUST come BEFORE you compose the visible reply. Triggers: (1) explicit voice asks (用语音 / 念一下 / 朗读 / say it aloud); (2) imitation / sound effects (学猫叫 / 学 X 的声音 / 模仿 X); (3) singing (唱一段 / sing X / 哼); (4) short voiced utterances (说 'hello' / 跟我说 X / 说句话); (5) when your written reply IS itself a sound ("喵喵", "汪~", "啊~", interjections). Writing '🔊' / '听语音版' / '(语音版~)' / '语音已发' WITHOUT having emitted a speak tool_call this turn is a forbidden hallucination (see rule #10). When in doubt, call the tool — a 🔊 button the user ignores is much less bad than writing fake "听语音版" text. Pass plain spoken-language text — no markdown, no URLs, no code. One call per reply.

LANGUAGE: When writing memory content (via remember / update_memory), write in the SAME LANGUAGE the user is using in the conversation. If the user writes in Chinese, store the fact in Chinese (e.g. "喜欢吃辣"). Do NOT translate.

MEMORY WRITING IN GROUP CONVERSATIONS:
- The default subject of remember / update_memory / forget_memory is the current speaker (${opts.currentUserName}).
- If you decide a fact is genuinely about another room member and worth storing across sessions, call remember with subjectName set to that member's name. The write lands in a pending queue; the subject will see it in their /memories "待确认" tab and can accept or reject it. Prefer NOT doing this unless the fact is both specific and clearly useful — casual descriptions of others should just be acknowledged in your reply.
- update_memory and forget_memory can only touch the current speaker's own memories (rows the tool returns as editable). Don't try to edit other members' rows.
- search_memories is already scoped to the current speaker. Other members' memories are not retrievable here.

For memory / room tools: prefer not calling if your current context is already sufficient. For web_search: the bar is the OPPOSITE — when in doubt about a verifiable factual question, search.`;

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

  // What you actually have. Without this section the agent defaults to
  // calling itself a "text-only assistant" because that's the LLM's
  // factory-self-image. State the real capability surface so questions
  // like "你能看图吗 / 你会说话吗 / 你能搜索吗" get truthful answers
  // and the agent knows to actually USE the tools instead of demurring.
  const capabilitiesLine = `WHAT YOU CAN DO (capabilities — real, not hypothetical):
- 看图: you DO see images. Image messages appear inline as "[图片#N (msgId=xxx)]" — N is the order in the recent window, msgId is the message id you'll pass to read_image. Call read_image(messageId) WHEN the user references that image and the answer depends on its contents. Don't read images proactively if the user is asking about something else; don't deny that you can see images either ("我只是文本模型" is wrong — you have the read_image tool).
- 说话 / 发声: call the speak(text) tool any time the user wants sound (imitation 学猫叫 / 学 X 的声音 / 模仿; singing 唱 X / 哼 X; short utterance 说 'X' / 跟我说; or your reply is itself a sound 喵喵 / 汪~ / 啊). **CALL THE TOOL FIRST**, then write text. Writing '🔊' / '听语音版' / '(语音版~)' WITHOUT a real tool_call is a forbidden hallucination (rule #10). Don't say "我不能说话" — you can.
- 画图: you can generate images via the generate_image tool (Doubao Seedream). **CALL THE TOOL FIRST**, THEN write a brief comment. Don't write '画着呢 / 稍等' WITHOUT calling — that's a hallucination (rule #10). For image edits / fusion pass referenceMessageIds. User says '停 / 别画了' → call cancel_image_generation with the messageId. Don't deny ("我不能画画") — you can.
- 搜索 / 浏览: web_search / search_music / search_lyrics / fetch_url all work — see the TOOLS section below. Don't say "我不能联网" — you can.
- 记忆: search_memories / remember etc let you retrieve and write durable facts about users across sessions. Long-term memory IS yours.
- 引用聊天记录: when you reference a specific earlier message (via search_messages, or because the user quoted one), embed it as a markdown link with a "msg:" href: '[查看原文](msg:<messageId>)' or '[Sasha 上次说的那句](msg:<messageId>)'. The user clicks → page scrolls + highlights that exact row. Use this for "你之前说过 X" / "你那天发的图" — anywhere a citation helps the user see the source. Don't dump raw msgIds at the user otherwise.

When asked "你能做什么" / "你是文本模型吗" / "你能看图吗" — answer based on this list, not on a generic LLM disclaimer.`;

  return [
    // Layer 1: Agent identity (system prompt)
    opts.agentPrompt || "You are a helpful assistant.",
    // Layer 1a: Capability declaration — counters the LLM's default
    // "I'm a text model" self-image with what the platform actually
    // wires up around it.
    capabilitiesLine,
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
2. Each user message is prefixed with "[YYYY-MM-DD HH:mm] (msgId=xxx) Name:" (e.g. "[2026-04-19 13:56] (msgId=abc-123-...) binqiu: hello"). The bracketed timestamp is metadata telling you WHEN that message was sent — NOT part of the user's words. The (msgId=...) is the unique id of THIS message — use it when you want to cite this exact message (see CITATION below). NEVER echo a timestamp or msgId in raw form back to the user; never start your reply with any of these bracketed prefixes. ALWAYS check the Name prefix to identify who is speaking. Different names = different people with different personalities and memories.
3. Do NOT repeat yourself. Before replying, review your recent responses above. If you already said something similar, say something new and different.
4. You are ${opts.agentName}. Never pretend to be a user. Never prefix your reply with a name or a timestamp.
5. Images appear inline as "[图片#N (msgId=xxx)]" where N is the image's order in the recent window (1 = earliest, increasing). When the user says "图3" / "the 3rd image" / "上面那张图", match it against N. To know what's IN the image, call read_image with the messageId — only when the user's question depends on its contents. Once read_image returns a caption, talk about the image naturally ("这张图里看到..."), don't add "我只是看了文字描述" disclaimers. If read_image returns { caption: null, status: "processing" }, say "图还在解析，稍等" — don't fabricate. If the user's current message isn't actually about an old image sitting in the recent window, just ignore the marker.
6. A user message may begin with a quoted-reply prefix "> [回复 NAME (msgId=xxx): <preview>] …" — this means the user is explicitly replying to that earlier message. Treat the quoted preview as the focus of their question, not the user's own words. The msgId in the prefix is the exact id of the quoted message; you may pass it to read_image (if the quote was an image) or cite it in your reply (see CITATION below). NEVER echo the "> [回复 …]" prefix back verbatim.
7. TOOL HONESTY: If you called a tool earlier in this turn (web_search / fetch_url / search_memories / etc), you DID call it. You can see the result yourself in the conversation history. NEVER claim "I didn't actually search" or "I didn't really look it up" — that's a lie. If a user asks "where did this come from?" / "你搜了哪些网页?", look back at the actual tool results and list the source URLs you used.

CITATION (linking back to earlier messages): when you tell the user about something they said earlier — pulled in via search_messages, referenced from a quote prefix's msgId, or recalled from context — embed it as a markdown link with the special "msg:" href: '[查看原文](msg:<messageId>)'. Examples:
  - "你上次说过 [想去成都](msg:abc-123-...)"
  - "群里那张图 [图片#3](msg:def-456-...) 我看过了"
  - "刚才 [Sasha 提的那句](msg:ghi-789-...) 我同意"
The frontend renders these as clickable chips that scroll the page to the exact row. NEVER paste a bare 'msg:abc-123' or a UUID at the user — always wrap it in markdown link form. Cite at MOST the most-relevant 1-2 messages; flooding the reply with citations defeats the purpose.

8. SEARCH BEFORE ANSWERING TIME-SENSITIVE QUESTIONS — THIS IS NOT OPTIONAL.

If the user asks about anything that COULD have happened or changed after your training cutoff, you MUST call web_search FIRST, then answer. "First" means before you write your reply. Not after you've drafted one. Not "let me give you a quick answer and then verify" — fabricated detail in the first answer is the harm we're preventing.

Trigger keywords (Chinese / English) — when ANY of these appear in the user's question, search before you type:
- 什么时候 / 哪天 / 几号 / when did / when will
- 最新 / 最近 / 现在 / 已经 / 还没 / 出了吗 / 发布了吗 / 上线了吗 / latest / now / already / released / launched / out yet
- 多少钱 / 价格 / 怎么卖 / price / how much
- 几个版本 / 哪些型号 / which versions / which models
- Any product name + date / version question you don't have crisp first-hand recall of (e.g. "DeepSeek V4", "Claude Opus 4.7", "iPhone 17", "GPT-5.5") — even if you THINK you remember, your training cutoff is months old; SEARCH.

Forbidden patterns:
- Confidently asserting a specific date / version / spec ("X 在 2026 年 4 月 24 日发布", "Y 的参数是 1.6T") without first calling web_search and citing a source. Even if you turn out to be right by luck, this is a lie.
- Hedge-and-fabricate: prefacing with "据我所知 / 我记得 / 应该是 / 可能是 / 大概在" and then inventing specifics. The hedge does not absolve you. Either search and answer with citations, or say "我不确定，让我搜一下" and search.
- "Knowledge cutoff" excuse without action: saying "我训练数据是 2025 年 X 月，所以可能不知道" — and then NOT calling web_search. The training cutoff is exactly why you must search.

If you only realize mid-reply that you should have searched, STOP, call web_search, then re-answer with citations. Don't continue with the fabricated draft.

9. RECALL BEFORE NARRATING PAST CONVERSATION — THIS IS NOT OPTIONAL.

You can identify any user message in this room by its msgId. Two sources:
  (a) Recent window: every user message in the conversation above carries an inline (msgId=...) — you have these ids without doing anything. To cite "the latest message", "上面那张图", "刚才说的那条" — pull the msgId straight from the prefix and use [text](msg:<id>) in your reply.
  (b) Older than the recent window: call search_messages — it scans the whole room and each result has an "id" field.

If the user asks about something said / done earlier in this room, you MUST verify before narrating. For content that's visibly in the recent window, cite by msgId from the prefix. For content older than the window — or anywhere you're not sure — call search_messages FIRST, then answer based on what it actually returns. Do NOT invent past quotes; do NOT pretend a topic wasn't discussed if you didn't search.

Trigger phrases — when ANY of these appear, call search_messages BEFORE you type your reply:
- 上次 / 之前 / 那次 / 那天 / 前几天 / 上回 / 早些时候 / 上周 / 昨天聊
- 还记得 / 记得吗 / 你说过 / 我说过 / 提过 / 聊过 / 发过
- "我们之前" / "你之前" / "刚才那个" (when "刚才" refers beyond the immediately preceding turn)
- earlier / before / last time / previously / remember when / we talked about / you mentioned / I said
- Any user question whose answer requires citing a SPECIFIC earlier message ("我那张图你看了吗", "上次说的成都那事")

Forbidden patterns:
- Confidently narrating "你之前说 X" / "我记得你提过 Y" / "上次咱们聊到 Z" without first calling search_messages and quoting / citing what came back. The user has receipts; you don't.
- Hedge-and-fabricate: "如果我没记错的话 / 印象中 / 大概是 / 应该是" + invented past content. The hedge does not absolve you — either search, or say "我不确定具体说了什么，让我搜一下" and then search.
- Saying "我没找到记录" / "看不到历史" without actually calling search_messages first. The tool exists; USE IT.
- Treating the recent-window as the whole history. If the topic isn't visibly in the latest 50 messages, that means nothing about whether it exists — search.

When search_messages returns matches: cite the most relevant 1-2 via [<short label>](msg:<id>) so the user can jump to the source. Quote the actual text only if it's short and load-bearing — otherwise summarize and link.

When search_messages returns nothing relevant: say so explicitly ("我搜了一下，房间里没找到 X 相关的内容"), don't fall back to guessing. Ask the user to clarify a date / keyword if it would help narrow the search.

This rule pairs with #8 — #8 is about external facts you can't verify from training; #9 is about ROOM HISTORY you CAN verify via search_messages but might still be tempted to fake.

10. ANTI-HALLUCINATION OF TOOL USE — never SAY you called a tool that you didn't actually call.

The platform actually tracks tool calls. The user has receipts. If you write "(点 🔊 听语音版~)" in your reply but didn't emit a tool_call for speak this turn, no audio button appears and the user immediately catches you. That's a worse failure than just answering plainly.

Forbidden phrases UNLESS you actually emitted the matching tool_call in THIS turn:
- "🔊" / "(点 🔊 听语音版)" / "听语音版" / "(语音已发)" / "(语音版~)" → only after speak({text})
- "画好了" / "图给你了" / "(图已生成)" / "看这张" / "上图~" / **"画着呢" / "稍等十几秒" / "稍等一下马上来" / "马上来" / "稍等几秒" / "正在画" / "画着呢，稍等" / "开始画了"** → only after generate_image({prompt}). Especially common failure: user says "画一只猫" → you write "画着呢～马上来" but emit NO tool_call. The "画着呢" phrasing is reserved for AFTER a real tool_call; without one, just say "我不太清楚怎么画" or call the tool.
- "我刚搜了一下" / "(查了下资料)" / "据搜索结果" / "翻了下资料" → only after web_search
- "我看了那张图" / "图里有 X" → only after read_image({messageId})
- "搜到了房间里这条" / "翻了下聊天记录" → only after search_messages

Two honest options when the user requests an action that needs a tool:
  (a) Call the tool. Then your reply CAN reference the result naturally.
  (b) Don't call. Then your reply MUST NOT presuppose the tool ran. Just say plainly: "我说一下" / "好" / your text.

NEVER DOUBLE DOWN ACROSS TURNS. If the user says "你没真调工具" / "其实没出按钮" / "图呢", they're right — trust the user, NOT your own past visible text. Admit immediately and retry the tool for real:
  ✅ "对不起，上一轮我说有调用但实际没发出去，这次真的调一下..."
  ❌ "我真的调了！是前端通路断了 / DB 你查一下 / 不信你点🔊!"
The user has the receipts; defending a fake claim is a worse failure than admitting it.

If a past assistant turn in this conversation has '[平台备注: ...]' appended at the end, that's the platform telling you THAT past turn hallucinated a tool call. Don't defend it. Acknowledge the failure if asked, and this turn actually call the tool.

This rule pairs with #7 (TOOL HONESTY) — #7 forbids DENYING tools you DID use; #10 forbids CLAIMING tools you DID NOT use. Both: your reply must match ground truth, not what you wish you had done.`,
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

interface ContextMessage {
  id?: string;
  senderType: string;
  senderId: string | null;
  content: string;
  contentType?: string | null;
  createdAt?: Date | string | null;
  metadata?: {
    vision?: { caption?: string };
    /** Set when the agent called the speak tool. Drives rule #10's
     *  retroactive [平台备注] detection of fake-tool-use claims. */
    audio?: { text: string; voiceId?: string };
  } | null;
  replyToMessageId?: string | null;
}

type LLMTextPart = { type: "text"; text: string };
type LLMImagePart = { type: "image_url"; image_url: { url: string } };
export type LLMContentPart = LLMTextPart | LLMImagePart;
export type LLMMessageContent = string | LLMContentPart[];

/**
 * Deduplicate context messages: when multiple agent responses are highly similar,
 * keep only the most recent one. This prevents the LLM from seeing repetitive
 * context and producing repetitive output.
 */
function deduplicateContext(msgs: ContextMessage[]): ContextMessage[] {
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

/** Build messages array for LLM.
 *
 *  Each user/assistant line is prefixed with a compact [YYYY-MM-DD HH:mm]
 *  timestamp so the agent sees time flow in the recent window — not just
 *  the one "Current time" anchor in the system prompt. If more than 6 hours
 *  have elapsed between the most recent message and now, we append a short
 *  note to the system prompt so the agent can acknowledge the gap naturally
 *  ("好久不见" etc) rather than responding as if no time passed.
 */
export function buildLLMMessages(
  systemContent: string,
  recentMessages: ContextMessage[],
  nameMap: Map<string, string>
) {
  const filtered = deduplicateContext(recentMessages);

  // Gap-since-last-message note. Threshold of 6h catches overnight / days-apart
  // sessions without triggering on normal back-and-forth chatting.
  let systemWithGap = systemContent;
  if (filtered.length > 0) {
    const last = filtered[filtered.length - 1];
    const lastTs = last.createdAt ? new Date(last.createdAt).getTime() : NaN;
    if (!isNaN(lastTs)) {
      const gapMs = Date.now() - lastTs;
      if (gapMs > 6 * 3600 * 1000) {
        const hours = gapMs / 3600000;
        const note =
          hours < 48
            ? `Note: about ${Math.round(hours)} hours have passed since the last message in this room.`
            : `Note: about ${Math.round(hours / 24)} days have passed since the last message in this room.`;
        systemWithGap = `${systemContent}\n\n${note}`;
      }
    }
  }

  // Number images by their order of appearance in the window so the agent
  // can disambiguate references like "图2 是什么" / "上面那张图" — without
  // numbering it has to guess which image when several share the window.
  let imageSeq = 0;

  // Map id → ContextMessage for resolving in-window quote targets. If a
  // user replies to a message that's still in the window we render a
  // structured "> [quote]" prefix so the agent can pinpoint it.
  const byId = new Map<string, ContextMessage>();
  for (const m of filtered) if (m.id) byId.set(m.id, m);

  // Sequence number assigned to images by appearance order; reused when a
  // reply targets one of those images so the quote prefix says "图片#N".
  const imageSeqByMessageId = new Map<string, number>();
  let probe = 0;
  for (const m of filtered) {
    if (m.contentType === "image" && m.id) {
      probe += 1;
      imageSeqByMessageId.set(m.id, probe);
    }
  }

  function quotePrefix(replyId: string): string {
    const target = byId.get(replyId);
    if (!target) {
      // Quote target scrolled out of the window — keep the signal that the
      // user explicitly referenced an earlier message but don't make up
      // content the agent can't see.
      return `> [回复了一条更早的消息（已超出最近窗口）]\n`;
    }
    const targetName = target.senderId
      ? nameMap.get(target.senderId) || (target.senderType === "agent" ? "agent" : "User")
      : target.senderType === "agent"
        ? "agent"
        : "User";
    let preview: string;
    if (target.contentType === "image") {
      // Stay consistent with the inline marker: identify by N + msgId.
      // Image quotes carry no caption — agent calls read_image if it
      // wants to know what's in there.
      const seq = imageSeqByMessageId.get(replyId);
      preview = `图片#${seq ?? "?"}`;
    } else {
      const oneLine = (target.content || "").replace(/\s+/g, " ").trim();
      preview = oneLine.length > 80 ? oneLine.slice(0, 80) + "…" : oneLine;
    }
    // Always include msgId so the agent can unambiguously tie the
    // quote back to a specific row (and cite it via [text](msg:<id>)
    // in its reply if useful).
    return `> [回复 ${targetName} (msgId=${replyId}): ${preview}]\n`;
  }

  return [
    { role: "system" as const, content: systemWithGap as LLMMessageContent },
    ...filtered.map((m) => {
      if (m.senderType === "user") {
        // Timestamp prefix is applied to user messages only. Putting it on
        // assistant messages causes the LLM to mimic the pattern and emit
        // "[YYYY-MM-DD HH:mm] ..." at the start of its own replies. The
        // agent can still infer when it replied from the adjacent user
        // timestamp, so no real signal is lost.
        const tsPrefix = m.createdAt
          ? `[${formatShortWallClock(new Date(m.createdAt))}] `
          : "";
        const name = m.senderId ? nameMap.get(m.senderId) || "User" : "User";
        const qPrefix = m.replyToMessageId ? quotePrefix(m.replyToMessageId) : "";
        // Inline (msgId=...) on every user message so the agent can
        // cite recent rows directly via [text](msg:<id>) without first
        // calling search_messages — which requires a query string and
        // can't answer "the latest message" anyway. Image markers
        // already carried the id; this generalizes the pattern.
        const idPrefix = m.id ? `(msgId=${m.id}) ` : "";
        if (m.contentType === "image" && m.content) {
          // Image bytes never reach the chat LLM. Inline a bare marker
          // with the message id; the agent calls `read_image(messageId)`
          // when it actually wants to know what's in the image. The
          // async caption pipeline keeps populating
          // messages.metadata.vision so by the time the agent calls the
          // tool the cache is usually warm.
          imageSeq += 1;
          const visionText = `[图片#${imageSeq} (msgId=${m.id})]`;
          return {
            role: "user" as const,
            content: `${qPrefix}${tsPrefix}${idPrefix}${name}: ${visionText}` as LLMMessageContent,
          };
        }
        return {
          role: "user" as const,
          content: `${qPrefix}${tsPrefix}${idPrefix}${name}: ${m.content}` as LLMMessageContent,
        };
      }
      // Agent's own past replies stay clean — leading metadata on an
      // assistant turn is the kind of thing the LLM mimics in its next
      // reply ("(msgId=...) ..." would leak into output). When user
      // asks about something the agent said, search_messages can find
      // it (it scans the whole room, agent-included).
      //
      // EXCEPTION: tool-use hallucination detox. If a past assistant
      // turn wrote phrases that PRESUPPOSE a tool ran (🔊 / 听语音版 /
      // etc) but the matching metadata is absent, the model
      // hallucinated the tool call — and on the next turn it'll keep
      // defending the fake claim ("我真的调了!"). Append a [平台备注]
      // to that past turn's visible content so the model sees ground
      // truth in its own context window. Combined with rule #10 in
      // the system prompt, this breaks the doubling-down loop.
      const halluNotes: string[] = [];
      const cnt = m.content || "";
      if (
        !m.metadata?.audio &&
        /🔊|听语音版|语音版|\(点.{0,4}听\)/.test(cnt)
      ) {
        halluNotes.push(
          "你写了 '🔊 / 听语音版' 字样但本轮 metadata.audio 为空 — speak 工具没真调。这是幻觉，下轮别辩护，承认并真调一次。"
        );
      }
      // generate_image hallucination: assistant wrote a "I'm
      // drawing it, hold on" phrase but no agent image-typed
      // message lands in the room within 60s after that turn,
      // meaning the tool was never called.
      if (/画着呢|稍等十几秒|稍等几秒|马上.{0,3}来|马上就好|正在画|开始画/.test(cnt)) {
        const ts = m.createdAt ? new Date(m.createdAt).getTime() : 0;
        const hasNearbyImage =
          ts > 0 &&
          filtered.some((other) => {
            if (other === m) return false;
            if (other.senderType !== "agent") return false;
            const ct = other.contentType ?? "";
            if (
              ct !== "image" &&
              ct !== "image-pending" &&
              ct !== "image-failed"
            )
              return false;
            const otherTs = other.createdAt
              ? new Date(other.createdAt).getTime()
              : 0;
            return otherTs >= ts && otherTs - ts < 60_000;
          });
        if (!hasNearbyImage) {
          halluNotes.push(
            "你写了 '画着呢 / 稍等' 字样但接下来 60 秒内房间里没有任何图片消息出现 — generate_image 工具没真调。这是幻觉。下次别再光说不练，要真的发出 tool_call。"
          );
        }
      }
      if (halluNotes.length > 0) {
        return {
          role: "assistant" as const,
          content: `${cnt}\n\n[平台备注: ${halluNotes.join(" / ")}]` as LLMMessageContent,
        };
      }
      return {
        role: "assistant" as const,
        content: m.content as LLMMessageContent,
      };
    }),
  ];
}

