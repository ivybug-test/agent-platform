import { db, sql } from "./client.js";
import { users, agents, rooms, roomMembers } from "./schema.js";

async function seed() {
  console.log("Seeding database...");

  // Default user
  const [user] = await db
    .insert(users)
    .values({
      name: "Demo User",
      email: "demo@example.com",
      passwordHash: "placeholder",
    })
    .returning();
  console.log("Created user:", user.id);

  // Default agent
  const [agent] = await db
    .insert(agents)
    .values({
      name: "Assistant",
      systemPrompt: "You are a helpful assistant.",
    })
    .returning();
  console.log("Created agent:", agent.id);

  // Default room
  const [room] = await db
    .insert(rooms)
    .values({
      name: "General",
    })
    .returning();
  console.log("Created room:", room.id);

  // Add user and agent to room
  await db.insert(roomMembers).values([
    { roomId: room.id, memberId: user.id, memberType: "user" },
    { roomId: room.id, memberId: agent.id, memberType: "agent" },
  ]);
  console.log("Added user and agent to room");

  await sql.end();
  console.log("Seed complete.");
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
