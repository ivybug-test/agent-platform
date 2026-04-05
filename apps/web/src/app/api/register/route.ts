import "@/lib/env";
import { NextRequest } from "next/server";
import { db, users } from "@agent-platform/db";
import { eq } from "drizzle-orm";
import { hash } from "bcryptjs";

export async function POST(req: NextRequest) {
  const { name, email, password } = await req.json();

  if (!name?.trim() || !email?.trim() || !password) {
    return Response.json({ error: "Name, email, and password are required" }, { status: 400 });
  }

  // Check if user exists
  const [existing] = await db.select().from(users).where(eq(users.email, email.trim()));
  if (existing) {
    return Response.json({ error: "Email already registered" }, { status: 409 });
  }

  const passwordHash = await hash(password, 10);
  const [user] = await db
    .insert(users)
    .values({ name: name.trim(), email: email.trim(), passwordHash })
    .returning({ id: users.id, name: users.name, email: users.email });

  return Response.json(user, { status: 201 });
}
