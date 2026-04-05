import "@/lib/env";
import { NextRequest } from "next/server";
import { db, messages, users, agents } from "@agent-platform/db";
import { eq, inArray } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const roomId = req.nextUrl.searchParams.get("roomId");
  if (!roomId) {
    return Response.json({ error: "Missing roomId" }, { status: 400 });
  }

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .orderBy(messages.createdAt)
    .limit(100);

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

  const result = rows.map((m) => ({
    ...m,
    senderName: m.senderId ? nameMap.get(m.senderId) || null : null,
  }));

  return Response.json({ messages: result, currentUserId: user.id });
}
