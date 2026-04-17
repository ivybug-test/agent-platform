import "@/lib/env";
import { NextRequest } from "next/server";
import { db, userMemories } from "@agent-platform/db";
import { and, eq, isNull } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";

const VALID_CATEGORIES = [
  "identity",
  "preference",
  "relationship",
  "event",
  "opinion",
  "context",
] as const;
const VALID_IMPORTANCES = ["high", "medium", "low"] as const;

type Category = (typeof VALID_CATEGORIES)[number];
type Importance = (typeof VALID_IMPORTANCES)[number];

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => null);

  const patch: {
    content?: string;
    category?: Category;
    importance?: Importance;
  } = {};

  if (typeof body?.content === "string") {
    const trimmed = body.content.trim();
    if (!trimmed) {
      return Response.json({ error: "content cannot be empty" }, { status: 400 });
    }
    patch.content = trimmed;
  }
  if (body?.category !== undefined) {
    if (!VALID_CATEGORIES.includes(body.category)) {
      return Response.json({ error: "invalid category" }, { status: 400 });
    }
    patch.category = body.category;
  }
  if (body?.importance !== undefined) {
    if (!VALID_IMPORTANCES.includes(body.importance)) {
      return Response.json({ error: "invalid importance" }, { status: 400 });
    }
    patch.importance = body.importance;
  }

  if (Object.keys(patch).length === 0) {
    return Response.json({ error: "nothing to update" }, { status: 400 });
  }

  const [row] = await db
    .update(userMemories)
    .set({
      ...patch,
      source: "user_explicit",
      lastReinforcedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userMemories.id, id),
        eq(userMemories.userId, user.id),
        isNull(userMemories.deletedAt)
      )
    )
    .returning();

  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(row);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  // Soft delete: becomes a tombstone the worker will honor. Mark as
  // user_explicit so the hard-delete path in the worker cannot revive or
  // re-overwrite it even if the LLM hallucinates a CREATE.
  const [row] = await db
    .update(userMemories)
    .set({
      deletedAt: new Date(),
      source: "user_explicit",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userMemories.id, id),
        eq(userMemories.userId, user.id),
        isNull(userMemories.deletedAt)
      )
    )
    .returning({ id: userMemories.id });

  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
