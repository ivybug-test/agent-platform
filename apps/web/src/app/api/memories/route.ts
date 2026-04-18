import "@/lib/env";
import { NextRequest } from "next/server";
import { db, userMemories, users } from "@agent-platform/db";
import { and, desc, eq, isNull, isNotNull, ne, inArray } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";
import { visibleToSubject } from "@/lib/memory-filters";

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

// Fields we expose to the /memories UI. Kept identical between the "mine"
// list and the "pending" list so the client can share a row renderer.
const SELECT_ROW = {
  id: userMemories.id,
  content: userMemories.content,
  category: userMemories.category,
  importance: userMemories.importance,
  source: userMemories.source,
  createdAt: userMemories.createdAt,
  updatedAt: userMemories.updatedAt,
  lastReinforcedAt: userMemories.lastReinforcedAt,
  authoredByUserId: userMemories.authoredByUserId,
  confirmedAt: userMemories.confirmedAt,
};

export async function GET() {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const mine = await db
    .select(SELECT_ROW)
    .from(userMemories)
    .where(and(eq(userMemories.userId, user.id), visibleToSubject()))
    .orderBy(desc(userMemories.importance), desc(userMemories.updatedAt));

  // "Pending" = third-party authored, not yet confirmed, not deleted.
  const pending = await db
    .select(SELECT_ROW)
    .from(userMemories)
    .where(
      and(
        eq(userMemories.userId, user.id),
        isNull(userMemories.deletedAt),
        isNotNull(userMemories.authoredByUserId),
        ne(userMemories.authoredByUserId, userMemories.userId),
        isNull(userMemories.confirmedAt)
      )
    )
    .orderBy(desc(userMemories.createdAt));

  // Resolve author display names for pending rows
  const authorIds = [
    ...new Set(pending.map((p) => p.authoredByUserId).filter(Boolean) as string[]),
  ];
  const authorNameRows =
    authorIds.length > 0
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, authorIds))
      : [];
  const nameMap = new Map(authorNameRows.map((r) => [r.id, r.name]));
  const pendingWithName = pending.map((p) => ({
    ...p,
    authoredByName: p.authoredByUserId ? nameMap.get(p.authoredByUserId) || "Unknown" : null,
  }));

  return Response.json({ mine, pending: pendingWithName });
}

export async function POST(req: NextRequest) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  const category = body?.category as Category;
  const importance = (body?.importance as Importance) || "medium";

  if (!content) {
    return Response.json({ error: "content required" }, { status: 400 });
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return Response.json({ error: "invalid category" }, { status: 400 });
  }
  if (!VALID_IMPORTANCES.includes(importance)) {
    return Response.json({ error: "invalid importance" }, { status: 400 });
  }

  const [row] = await db
    .insert(userMemories)
    .values({
      userId: user.id,
      content,
      category,
      importance,
      source: "user_explicit",
      lastReinforcedAt: new Date(),
    })
    .returning();

  return Response.json(row, { status: 201 });
}
