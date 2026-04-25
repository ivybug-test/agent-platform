import "@/lib/env";
import { NextRequest } from "next/server";
import { getRequiredUser } from "@/lib/session";
import { getLinkPreview } from "@/lib/link-preview";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return Response.json({ error: "url is required" }, { status: 400 });
  }

  const preview = await getLinkPreview(url);
  return Response.json(preview);
}
