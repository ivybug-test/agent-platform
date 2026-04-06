import "@/lib/env";
import { db, inviteCodes, users } from "@agent-platform/db";
import { eq } from "drizzle-orm";
import { getRequiredUser } from "@/lib/session";
import crypto from "crypto";

// List invite codes (admin only)
export async function GET() {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const [dbUser] = await db.select().from(users).where(eq(users.id, user.id));
  if (!dbUser?.isAdmin) return Response.json({ error: "Admin only" }, { status: 403 });

  const codes = await db.select().from(inviteCodes).where(eq(inviteCodes.createdBy, user.id));
  return Response.json(codes);
}

// Generate invite code (admin only)
export async function POST() {
  const user = await getRequiredUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const [dbUser] = await db.select().from(users).where(eq(users.id, user.id));
  if (!dbUser?.isAdmin) return Response.json({ error: "Admin only" }, { status: 403 });

  const code = crypto.randomBytes(4).toString("hex");

  const [invite] = await db
    .insert(inviteCodes)
    .values({ code, createdBy: user.id })
    .returning();

  return Response.json(invite, { status: 201 });
}
