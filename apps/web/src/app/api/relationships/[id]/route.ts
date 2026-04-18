import "@/lib/env";
import { NextRequest } from "next/server";
import { db, userRelationships } from "@agent-platform/db";
import { and, eq, isNull, or } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const [row] = await db
    .update(userRelationships)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(userRelationships.id, id),
        isNull(userRelationships.deletedAt),
        or(
          eq(userRelationships.aUserId, user.id),
          eq(userRelationships.bUserId, user.id)
        )
      )
    )
    .returning({ id: userRelationships.id });

  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
