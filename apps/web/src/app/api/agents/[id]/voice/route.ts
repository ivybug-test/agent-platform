import "@/lib/env";
import { NextRequest } from "next/server";
import { db, agents } from "@agent-platform/db";
import { eq } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** PATCH /api/agents/[id]/voice
 *  body: { voiceProvider, voiceId, voiceName } (all optional / nullable)
 *
 *  Voice is a property of the agent itself (not of any room the agent
 *  happens to be in), so any authenticated user can configure it — the
 *  whole product currently runs on a single shared agent and the
 *  setting is global. Pass null on any field to clear it (revert to
 *  the active provider's default voice). */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: agentId } = await params;

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

  if (!row) {
    return Response.json({ error: "agent not found" }, { status: 404 });
  }

  return Response.json(row);
}

function stringOrNull(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}
