import "@/lib/env";
import { NextRequest } from "next/server";
import { db, messages, users, agents, roomMembers } from "@agent-platform/db";
import { eq, inArray, desc, and, lt } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";
import { bulkReplySnippets } from "@/lib/chat/reply-snippet";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const roomId = req.nextUrl.searchParams.get("roomId");
  if (!roomId) {
    return Response.json({ error: "Missing roomId" }, { status: 400 });
  }

  const before = req.nextUrl.searchParams.get("before"); // ISO timestamp cursor
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 100, 200);

  const conditions = [eq(messages.roomId, roomId)];
  if (before) {
    conditions.push(lt(messages.createdAt, new Date(before)));
  }

  const rowsDesc = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(limit + 1); // fetch one extra to determine hasMore

  const hasMore = rowsDesc.length > limit;
  if (hasMore) rowsDesc.pop();
  const rows = rowsDesc.reverse();

  // Resolve sender names
  const userIds = [...new Set(rows.filter((m) => m.senderType === "user" && m.senderId).map((m) => m.senderId!))];
  const agentIds = [...new Set(rows.filter((m) => m.senderType === "agent" && m.senderId).map((m) => m.senderId!))];

  const [userRows, agentRows] = await Promise.all([
    userIds.length > 0
      ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))
      : [],
    agentIds.length > 0
      ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
      : [],
  ]);

  const nameMap = new Map<string, string>();
  for (const u of userRows) nameMap.set(u.id, u.name);
  for (const a of agentRows) nameMap.set(a.id, a.name);

  // Resolve quoted-message snippets for any message that has a reply
  // target. One bulk lookup avoids an N+1 over the page.
  const replyTargetIds = [
    ...new Set(
      rows.map((m) => m.replyToMessageId).filter((x): x is string => !!x)
    ),
  ];
  const replyMap = await bulkReplySnippets(replyTargetIds);

  const result = rows.map((m) => ({
    ...m,
    senderName: m.senderId ? nameMap.get(m.senderId) || null : null,
    replyTo: m.replyToMessageId ? replyMap.get(m.replyToMessageId) ?? null : null,
  }));

  // Resolve the room's primary agent so the client can label optimistic
  // placeholders with the real name (DB might say "Assistant", "Maya",
  // etc.). Avoids the "Agent → Assistant" flip on every page reload.
  const [agentMember] = await db
    .select()
    .from(roomMembers)
    .where(
      and(eq(roomMembers.roomId, roomId), eq(roomMembers.memberType, "agent"))
    )
    .limit(1);
  let agentInfo: { id: string; name: string } | null = null;
  if (agentMember) {
    const [agent] = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentMember.memberId));
    if (agent) agentInfo = agent;
  }

  return Response.json({
    messages: result,
    currentUserId: user.id,
    hasMore,
    roomAgent: agentInfo,
  });
}
