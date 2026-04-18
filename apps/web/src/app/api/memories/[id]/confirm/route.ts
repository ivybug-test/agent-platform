import "@/lib/env";
import { NextRequest } from "next/server";
import { db, userMemories } from "@agent-platform/db";
import { and, eq, isNull, isNotNull, ne } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";

/**
 * POST /api/memories/:id/confirm
 * The subject accepts a pending third-party write. No body required.
 * Fails 404 if the row isn't a pending third-party write for this user.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const [row] = await db
    .update(userMemories)
    .set({ confirmedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(userMemories.id, id),
        eq(userMemories.userId, user.id),
        isNull(userMemories.deletedAt),
        isNotNull(userMemories.authoredByUserId),
        ne(userMemories.authoredByUserId, userMemories.userId),
        isNull(userMemories.confirmedAt)
      )
    )
    .returning();

  if (!row) {
    return Response.json(
      { error: "pending memory not found" },
      { status: 404 }
    );
  }
  return Response.json(row);
}
