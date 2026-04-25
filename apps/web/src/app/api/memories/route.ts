import "@/lib/env";
import { NextRequest } from "next/server";
import { db, userMemories, users } from "@agent-platform/db";
import { and, desc, eq, ilike, isNull, isNotNull, ne, inArray } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";
import { visibleToSubject } from "@/lib/memory-filters";
import { getAcceptedFriendIds } from "@/lib/friends";

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
  eventAt: userMemories.eventAt,
  authoredByUserId: userMemories.authoredByUserId,
  confirmedAt: userMemories.confirmedAt,
};

/** Escape `\`, `%`, `_` so user input doesn't act as wildcards in ILIKE. */
function escLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export async function GET(req: NextRequest) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const q = req.nextUrl.searchParams.get("q")?.trim() || "";
  const queryFilter = q
    ? ilike(userMemories.content, `%${escLike(q)}%`)
    : undefined;

  // Sort by updatedAt — "recent" view takes the top N, "全部" view groups
  // by category client-side. Importance no longer drives the primary sort
  // since the redesigned UI doesn't pin by importance up top anymore.
  const mine = await db
    .select(SELECT_ROW)
    .from(userMemories)
    .where(
      and(
        eq(userMemories.userId, user.id),
        visibleToSubject(),
        ...(queryFilter ? [queryFilter] : [])
      )
    )
    .orderBy(desc(userMemories.updatedAt));

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
        isNull(userMemories.confirmedAt),
        ...(queryFilter ? [queryFilter] : [])
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

  // Friends list — populates the "+ 新增" form's subject selector so the
  // user can write a pending memory directly to a friend without going
  // through the agent's `remember(subjectName=…)` tool.
  const friendIds = await getAcceptedFriendIds(user.id);
  const friends =
    friendIds.length > 0
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, friendIds))
      : [];

  return Response.json({ mine, pending: pendingWithName, friends });
}

export async function POST(req: NextRequest) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  const category = body?.category as Category;
  const importance = (body?.importance as Importance) || "medium";
  const subjectUserId =
    typeof body?.subjectUserId === "string" ? body.subjectUserId : null;

  if (!content) {
    return Response.json({ error: "content required" }, { status: 400 });
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return Response.json({ error: "invalid category" }, { status: 400 });
  }
  if (!VALID_IMPORTANCES.includes(importance)) {
    return Response.json({ error: "invalid importance" }, { status: 400 });
  }

  // Decide write target. Default = self. If a subjectUserId is provided
  // (and it's not just the caller's own id), validate it's an accepted
  // friend, then insert as pending.
  let targetUserId = user.id;
  let isThirdParty = false;
  if (subjectUserId && subjectUserId !== user.id) {
    const friendIds = await getAcceptedFriendIds(user.id);
    if (!friendIds.includes(subjectUserId)) {
      return Response.json(
        { error: "subjectUserId must be an accepted friend" },
        { status: 403 }
      );
    }
    targetUserId = subjectUserId;
    isThirdParty = true;
  }

  const [row] = await db
    .insert(userMemories)
    .values({
      userId: targetUserId,
      content,
      category,
      importance,
      // user_explicit on both paths — the user is the one explicitly
      // creating it, so the worker's auto-update should not touch it.
      source: "user_explicit",
      authoredByUserId: isThirdParty ? user.id : null,
      confirmedAt: null,
      lastReinforcedAt: new Date(),
    })
    .returning();

  return Response.json(
    { ...row, pending: isThirdParty },
    { status: 201 }
  );
}
