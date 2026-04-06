import "@/lib/env";
import { NextRequest } from "next/server";
import { db, users, inviteCodes } from "@agent-platform/db";
import { eq, and, isNull } from "drizzle-orm";
import { hash } from "bcryptjs";

export async function POST(req: NextRequest) {
  const { name, email, password, inviteCode } = await req.json();

  if (!name?.trim() || !email?.trim() || !password) {
    return Response.json({ error: "Name, email, and password are required" }, { status: 400 });
  }

  if (!inviteCode?.trim()) {
    return Response.json({ error: "Invite code is required" }, { status: 400 });
  }

  // Validate invite code
  const [invite] = await db
    .select()
    .from(inviteCodes)
    .where(and(eq(inviteCodes.code, inviteCode.trim()), isNull(inviteCodes.usedBy)));

  if (!invite) {
    return Response.json({ error: "Invalid or already used invite code" }, { status: 400 });
  }

  // Check if user exists
  const [existing] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
  if (existing) {
    return Response.json({ error: "Email already registered" }, { status: 409 });
  }

  const passwordHash = await hash(password, 10);
  const [user] = await db
    .insert(users)
    .values({ name: name.trim(), email: email.trim().toLowerCase(), passwordHash })
    .returning({ id: users.id, name: users.name, email: users.email });

  // Mark invite code as used
  await db
    .update(inviteCodes)
    .set({ usedBy: user.id, usedAt: new Date() })
    .where(eq(inviteCodes.id, invite.id));

  return Response.json(user, { status: 201 });
}
