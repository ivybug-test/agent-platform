import "@/lib/env";
import { NextRequest } from "next/server";
import { db, userRelationships, users } from "@agent-platform/db";
import { and, eq, isNull, or, inArray } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";

const VALID_KINDS = ["spouse", "family", "colleague", "friend", "custom"] as const;
type Kind = (typeof VALID_KINDS)[number];

export async function GET() {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select()
    .from(userRelationships)
    .where(
      and(
        isNull(userRelationships.deletedAt),
        or(
          eq(userRelationships.aUserId, user.id),
          eq(userRelationships.bUserId, user.id)
        )
      )
    );

  const otherIds = [
    ...new Set(
      rows.map((r) => (r.aUserId === user.id ? r.bUserId : r.aUserId))
    ),
  ];
  const nameRows =
    otherIds.length > 0
      ? await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.id, otherIds))
      : [];
  const nameMap = new Map(nameRows.map((u) => [u.id, u]));

  const confirmed: any[] = [];
  const pending: any[] = []; // incoming proposals waiting for *this* user's ack
  const outgoing: any[] = []; // proposals this user made, waiting for the other side

  for (const r of rows) {
    const isA = r.aUserId === user.id;
    const mySide = isA ? r.confirmedByA : r.confirmedByB;
    const theirSide = isA ? r.confirmedByB : r.confirmedByA;
    const otherId = isA ? r.bUserId : r.aUserId;
    const other = nameMap.get(otherId) || {
      id: otherId,
      name: "Unknown",
      email: "",
    };
    const shape = {
      id: r.id,
      kind: r.kind,
      content: r.content,
      createdAt: r.createdAt,
      other,
    };
    if (mySide && theirSide) confirmed.push(shape);
    else if (!mySide && theirSide) pending.push(shape);
    else if (mySide && !theirSide) outgoing.push(shape);
  }

  return Response.json({ confirmed, pending, outgoing });
}

export async function POST(req: NextRequest) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const otherUserId =
    typeof body?.otherUserId === "string" ? body.otherUserId.trim() : "";
  const kind = body?.kind as Kind;
  const content =
    typeof body?.content === "string" ? body.content.trim() : null;

  if (!otherUserId) return Response.json({ error: "otherUserId required" }, { status: 400 });
  if (otherUserId === user.id) return Response.json({ error: "cannot relate to yourself" }, { status: 400 });
  if (!VALID_KINDS.includes(kind)) return Response.json({ error: "invalid kind" }, { status: 400 });

  const [aId, bId] = user.id < otherUserId ? [user.id, otherUserId] : [otherUserId, user.id];
  const speakerIsA = user.id === aId;
  const now = new Date();

  const [existing] = await db
    .select()
    .from(userRelationships)
    .where(
      and(
        eq(userRelationships.aUserId, aId),
        eq(userRelationships.bUserId, bId),
        eq(userRelationships.kind, kind),
        isNull(userRelationships.deletedAt)
      )
    );

  if (existing) {
    const patch = speakerIsA
      ? { confirmedByA: now, updatedAt: now }
      : { confirmedByB: now, updatedAt: now };
    if (content !== null) (patch as any).content = content;
    const [updated] = await db
      .update(userRelationships)
      .set(patch)
      .where(eq(userRelationships.id, existing.id))
      .returning();
    return Response.json(updated);
  }

  const [row] = await db
    .insert(userRelationships)
    .values({
      aUserId: aId,
      bUserId: bId,
      kind,
      content,
      confirmedByA: speakerIsA ? now : null,
      confirmedByB: speakerIsA ? null : now,
    })
    .returning();
  return Response.json(row, { status: 201 });
}
