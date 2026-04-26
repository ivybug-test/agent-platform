import "@/lib/env";
import { db, agents } from "@agent-platform/db";
import { getRequiredUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** GET /api/agents — list every agent in the system + its current voice
 *  settings. Used by the /me page's voice picker card.
 *
 *  Agents are a product-wide resource (this is a single-agent product
 *  shared across all rooms / all users), so any authenticated user can
 *  see and configure them. We deliberately don't filter by "rooms I
 *  share with this agent" — that scoping made the picker disappear
 *  whenever the agent hadn't been bound to one of the user's rooms,
 *  even though the voice setting is global. */
export async function GET() {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      voiceProvider: agents.voiceProvider,
      voiceId: agents.voiceId,
      voiceName: agents.voiceName,
    })
    .from(agents)
    .orderBy(agents.createdAt);

  return Response.json({ agents: rows });
}
