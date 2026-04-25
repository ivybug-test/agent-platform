import "@/lib/env";
import { NextRequest } from "next/server";
import { db, agents, roomMembers, rooms } from "@agent-platform/db";
import { and, eq } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** PATCH /api/agents/[id]/voice
 *  body: { voiceProvider, voiceId, voiceName } (all optional / nullable)
 *
 *  Authorization: caller must share a room with this agent (room
 *  membership is the project's de-facto "you can configure this agent"
 *  signal — agents aren't owned by individual users). Pass null on any
 *  field to clear it (revert to default voice). */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: agentId } = await params;

  // Membership check: caller is in some room that contains this agent.
  const [share] = await db
    .select({ roomId: roomMembers.roomId })
    .from(roomMembers)
    .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
    .where(
      and(
        eq(roomMembers.memberId, agentId),
        eq(roomMembers.memberType, "agent")
      )
    )
    .limit(1);
  if (!share) {
    return Response.json({ error: "agent not found" }, { status: 404 });
  }
  const [membership] = await db
    .select()
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.roomId, share.roomId),
        eq(roomMembers.memberId, user.id),
        eq(roomMembers.memberType, "user")
      )
    )
    .limit(1);
  if (!membership) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const voiceProvider = stringOrNull(body?.voiceProvider);
  const voiceId = stringOrNull(body?.voiceId);
  const voiceName = stringOrNull(body?.voiceName);

  const [row] = await db
    .update(agents)
    .set({ voiceProvider, voiceId, voiceName })
    .where(eq(agents.id, agentId))
    .returning({
      id: agents.id,
      voiceProvider: agents.voiceProvider,
      voiceId: agents.voiceId,
      voiceName: agents.voiceName,
    });

  return Response.json(row);
}

function stringOrNull(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}
