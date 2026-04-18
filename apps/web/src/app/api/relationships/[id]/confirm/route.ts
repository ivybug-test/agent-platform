import "@/lib/env";
import { NextRequest } from "next/server";
import { db, userRelationships } from "@agent-platform/db";
import { and, eq, isNull, or } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";

/**
 * POST /api/relationships/:id/confirm
 * The user confirms their side of a pending relationship edge proposed by
 * the other party. Sets confirmedByA or confirmedByB to now() depending on
 * which side the caller is on. Idempotent.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const [row] = await db
    .select()
    .from(userRelationships)
    .where(
      and(
        eq(userRelationships.id, id),
        isNull(userRelationships.deletedAt),
        or(
          eq(userRelationships.aUserId, user.id),
          eq(userRelationships.bUserId, user.id)
        )
      )
    );
  if (!row) return Response.json({ error: "not found" }, { status: 404 });

  const now = new Date();
  const patch = row.aUserId === user.id
    ? { confirmedByA: now, updatedAt: now }
    : { confirmedByB: now, updatedAt: now };

  const [updated] = await db
    .update(userRelationships)
    .set(patch)
    .where(eq(userRelationships.id, id))
    .returning();

  return Response.json(updated);
}
