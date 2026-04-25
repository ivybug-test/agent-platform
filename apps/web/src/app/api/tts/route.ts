import "@/lib/env";
import { NextRequest } from "next/server";
import { db, agents } from "@agent-platform/db";
import { eq } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";
import { getActiveProvider, getProviderByName } from "@/lib/tts";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("web");

export const dynamic = "force-dynamic";

const MAX_TEXT_LEN = 4000;

/** POST /api/tts
 *  body: { text: string, agentId?: string, voiceId?: string, voiceProvider?: string }
 *
 *  When agentId is given, look up that agent's saved voice and use it
 *  unless voiceId / voiceProvider in the body explicitly override. The
 *  response streams audio/mpeg chunks for direct piping into a browser
 *  MediaSource. */
export async function POST(req: NextRequest) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    return Response.json({ error: "text required" }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LEN) {
    return Response.json(
      { error: `text too long (max ${MAX_TEXT_LEN} chars)` },
      { status: 400 }
    );
  }

  // Resolve voice: explicit body override → agent's saved voice → provider default.
  let voiceId: string | undefined =
    typeof body?.voiceId === "string" ? body.voiceId : undefined;
  let voiceProviderName: string | undefined =
    typeof body?.voiceProvider === "string" ? body.voiceProvider : undefined;
  const agentId = typeof body?.agentId === "string" ? body.agentId : null;
  if (agentId && (!voiceId || !voiceProviderName)) {
    const [agent] = await db
      .select({
        voiceId: agents.voiceId,
        voiceProvider: agents.voiceProvider,
      })
      .from(agents)
      .where(eq(agents.id, agentId));
    if (agent) {
      voiceId = voiceId || agent.voiceId || undefined;
      voiceProviderName = voiceProviderName || agent.voiceProvider || undefined;
    }
  }

  const provider = voiceProviderName
    ? getProviderByName(voiceProviderName) || getActiveProvider()
    : getActiveProvider();

  const startedAt = Date.now();
  let audioStream: ReadableStream<Uint8Array>;
  try {
    audioStream = await provider.synthesize({
      text,
      voiceId,
      signal: req.signal,
    });
  } catch (err) {
    log.error(
      {
        err: (err as Error)?.message,
        provider: provider.name,
        userId: user.id,
      },
      "tts.synth-error"
    );
    return Response.json(
      { error: `tts failed: ${(err as Error)?.message || "unknown"}` },
      { status: 502 }
    );
  }

  log.info(
    {
      userId: user.id,
      provider: provider.name,
      voiceId: voiceId || "(default)",
      textLen: text.length,
      durationMs: Date.now() - startedAt,
    },
    "tts.start"
  );

  return new Response(audioStream, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
