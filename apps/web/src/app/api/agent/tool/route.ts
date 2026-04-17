import "@/lib/env";
import { NextRequest } from "next/server";
import { verifyToolToken } from "@/lib/tool-token";
import { getTool, parseToolArgs } from "@/lib/tools";
import { createLogger } from "@agent-platform/logger";

const log = createLogger("web");

export async function POST(req: NextRequest) {
  // 1. Extract + verify internal JWT from agent-runtime
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";
  if (!token) {
    return Response.json(
      { error: "missing bearer token" },
      { status: 401 }
    );
  }

  let ctx;
  try {
    ctx = await verifyToolToken(token);
  } catch (err: any) {
    log.warn({ err: err?.message }, "tool.token-invalid");
    return Response.json({ error: "invalid token" }, { status: 401 });
  }

  // 2. Parse body
  const body = await req.json().catch(() => null);
  const name = typeof body?.tool === "string" ? body.tool : "";
  if (!name) {
    return Response.json({ error: "missing tool name" }, { status: 400 });
  }

  const handler = getTool(name);
  if (!handler) {
    return Response.json(
      { error: `unknown tool: ${name}` },
      { status: 404 }
    );
  }

  // 3. Dispatch
  const args = parseToolArgs(body?.arguments);
  const started = Date.now();
  try {
    const result = await handler(args, ctx);
    log.info(
      {
        tool: name,
        userId: ctx.userId,
        roomId: ctx.roomId,
        duration: Date.now() - started,
      },
      "tool.ok"
    );
    return Response.json(result);
  } catch (err: any) {
    log.error(
      {
        tool: name,
        userId: ctx.userId,
        roomId: ctx.roomId,
        err: err?.message,
      },
      "tool.failed"
    );
    return Response.json(
      { error: err?.message || "tool failed" },
      { status: 500 }
    );
  }
}
