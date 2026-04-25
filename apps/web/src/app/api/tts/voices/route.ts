import "@/lib/env";
import { getRequiredUser } from "@/lib/session";
import { getActiveProvider } from "@/lib/tts";

export const dynamic = "force-dynamic";

/** GET /api/tts/voices — preset voice list for the picker UI.
 *  Returns the active provider's voices plus its name so the client
 *  can render section headers / fall back gracefully if mock is on. */
export async function GET() {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const provider = getActiveProvider();
  return Response.json({
    provider: provider.name,
    voices: provider.voices(),
  });
}
