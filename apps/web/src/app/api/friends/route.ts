import "@/lib/env";
import { NextRequest } from "next/server";
import { db, friendships, users } from "@agent-platform/db";
import { eq, and, or } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";

export async function GET() {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select()
    .from(friendships)
    .where(
      or(
        eq(friendships.requesterId, user.id),
        eq(friendships.addresseeId, user.id)
      )
    );

  // Resolve friend info
  const friendUserIds = rows.map((r) =>
    r.requesterId === user.id ? r.addresseeId : r.requesterId
  );

  const friendUsers =
    friendUserIds.length > 0
      ? await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(
            or(...friendUserIds.map((id) => eq(users.id, id)))
          )
      : [];

  const userMap = new Map(friendUsers.map((u) => [u.id, u]));

  const result = rows.map((r) => {
    const friendId =
      r.requesterId === user.id ? r.addresseeId : r.requesterId;
    const direction =
      r.status === "accepted"
        ? "mutual"
        : r.requesterId === user.id
          ? "outgoing"
          : "incoming";

    return {
      id: r.id,
      status: r.status,
      direction,
      friend: userMap.get(friendId) || { id: friendId, name: "Unknown", email: "" },
      createdAt: r.createdAt,
    };
  });

  return Response.json(result);
}

export async function POST(req: NextRequest) {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { email } = await req.json();
  if (!email?.trim()) {
    return Response.json({ error: "Email is required" }, { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();

  if (normalizedEmail === user.email) {
    return Response.json({ error: "Cannot add yourself" }, { status: 400 });
  }

  // Find addressee
  const [addressee] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.email, normalizedEmail));

  if (!addressee) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }

  // Check existing friendship
  const [existing] = await db
    .select()
    .from(friendships)
    .where(
      or(
        and(
          eq(friendships.requesterId, user.id),
          eq(friendships.addresseeId, addressee.id)
        ),
        and(
          eq(friendships.requesterId, addressee.id),
          eq(friendships.addresseeId, user.id)
        )
      )
    );

  if (existing) {
    return Response.json(
      { error: "Friend request already exists" },
      { status: 409 }
    );
  }

  const [friendship] = await db
    .insert(friendships)
    .values({
      requesterId: user.id,
      addresseeId: addressee.id,
    })
    .returning();

  return Response.json(
    {
      id: friendship.id,
      status: friendship.status,
      direction: "outgoing",
      friend: addressee,
    },
    { status: 201 }
  );
}
