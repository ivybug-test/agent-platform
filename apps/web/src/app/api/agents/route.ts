import "@/lib/env";
import { db, agents, roomMembers } from "@agent-platform/db";
import { and, eq, inArray } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** GET /api/agents — list every agent the current user shares a room
 *  with, plus its saved voice settings. Used by the /me page's voice
 *  picker card. Returns an empty list when the user has no rooms or
 *  no agents in any of their rooms. */
export async function GET() {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // Two-step: rooms I'm in → agents in those rooms.
  const myRooms = await db
    .select({ roomId: roomMembers.roomId })
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.memberId, user.id),
        eq(roomMembers.memberType, "user")
      )
    );
  const roomIds = myRooms.map((r) => r.roomId);
  if (roomIds.length === 0) return Response.json({ agents: [] });

  const agentMembers = await db
    .select({ agentId: roomMembers.memberId })
    .from(roomMembers)
    .where(
      and(
        inArray(roomMembers.roomId, roomIds),
        eq(roomMembers.memberType, "agent")
      )
    );
  const agentIds = [...new Set(agentMembers.map((a) => a.agentId))];
  if (agentIds.length === 0) return Response.json({ agents: [] });

  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      voiceProvider: agents.voiceProvider,
      voiceId: agents.voiceId,
      voiceName: agents.voiceName,
    })
    .from(agents)
    .where(inArray(agents.id, agentIds));

  return Response.json({ agents: rows });
}
