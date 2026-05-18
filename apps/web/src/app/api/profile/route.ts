import "@/lib/env";
import {
  db,
  agentMemories,
  agents,
  roomMembers,
  roomObservations,
  rooms,
} from "@agent-platform/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";

// Profile view payload. Aggregates the cross-table "what the agent thinks
// of me" data that the /memories page surfaces in its 画像 (profile) tab.
//
//   narratives    agent_memories.kind='narrative' scoped to current user.
//                 Joined with agents for display name. One agent can hold
//                 multiple narratives (one per scope), but we typically
//                 expect 1 per (agent, user).
//
//   observations  Cross-room dated observation logs from rooms the user
//                 is a member of. Privacy: only the user's own rooms.
const OBSERVATION_LIMIT = 20;

export async function GET() {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // Narratives — agent-authored paragraphs about THIS user. Includes both
  // (agent, user) and (agent, room) scoped rows that also reference the
  // user; for now we only surface scope_user_id rows because room-scoped
  // ones are about the room dynamic, not the user specifically.
  const narrativeRows = await db
    .select({
      id: agentMemories.id,
      content: agentMemories.content,
      agentId: agentMemories.agentId,
      agentName: agents.name,
      updatedAt: agentMemories.updatedAt,
    })
    .from(agentMemories)
    .innerJoin(agents, eq(agents.id, agentMemories.agentId))
    .where(
      and(
        eq(agentMemories.kind, "narrative"),
        eq(agentMemories.scopeUserId, user.id),
        isNull(agentMemories.deletedAt)
      )
    )
    .orderBy(desc(agentMemories.updatedAt));

  // Observation logs from rooms the user is a member of. Cross-room view
  // gives the user a single timeline of "what's been happening".
  const userRoomIds = (
    await db
      .select({ roomId: roomMembers.roomId })
      .from(roomMembers)
      .where(
        and(eq(roomMembers.memberId, user.id), eq(roomMembers.memberType, "user"))
      )
  ).map((r) => r.roomId);

  const observationRows = userRoomIds.length
    ? await db
        .select({
          id: roomObservations.id,
          content: roomObservations.content,
          roomId: roomObservations.roomId,
          roomName: rooms.name,
          periodStart: roomObservations.periodStart,
          periodEnd: roomObservations.periodEnd,
        })
        .from(roomObservations)
        .innerJoin(rooms, eq(rooms.id, roomObservations.roomId))
        .where(inArray(roomObservations.roomId, userRoomIds))
        .orderBy(desc(roomObservations.periodEnd))
        .limit(OBSERVATION_LIMIT)
    : [];

  return Response.json({
    narratives: narrativeRows,
    observations: observationRows,
  });
}
