import "@/lib/env";
import { NextRequest } from "next/server";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("telemetry");

/** Lightweight client → server event sink. The browser POSTs JSON like
 *  `{ event: "image-broken", messageId, url, ... }`; we just structurally
 *  log it so we can grep occurrence rates and decide where to invest.
 *  No auth — telemetry is fire-and-forget and contains no secrets; we
 *  cap the payload size so a misbehaving client can't flood the log. */
export const dynamic = "force-dynamic";

const MAX_PAYLOAD_BYTES = 4096;

export async function POST(req: NextRequest) {
  try {
    const text = await req.text();
    if (text.length > MAX_PAYLOAD_BYTES) {
      return Response.json({ ok: false, reason: "payload too large" }, { status: 413 });
    }
    const body = JSON.parse(text) as { event?: unknown };
    const event =
      typeof body.event === "string" && body.event.length < 64 ? body.event : null;
    if (!event) {
      return Response.json({ ok: false, reason: "missing event" }, { status: 400 });
    }
    log.info({ ...body, event }, `client.${event}`);
  } catch {
    // Swallow — telemetry must not error-loop the client.
  }
  return Response.json({ ok: true });
}
