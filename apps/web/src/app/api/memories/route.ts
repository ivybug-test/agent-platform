import "@/lib/env";
import { NextRequest } from "next/server";
import { db, userMemories } from "@agent-platform/db";
import { and, desc, eq, isNull } from "drizzle-orm";
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

export async function GET() {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select({
      id: userMemories.id,
      content: userMemories.content,
      category: userMemories.category,
      importance: userMemories.importance,
      source: userMemories.source,
      createdAt: userMemories.createdAt,
      updatedAt: userMemories.updatedAt,
      lastReinforcedAt: userMemories.lastReinforcedAt,
    })
    .from(userMemories)
    .where(
      and(eq(userMemories.userId, user.id), isNull(userMemories.deletedAt))
    )
    .orderBy(desc(userMemories.importance), desc(userMemories.updatedAt));

  return Response.json(rows);
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
