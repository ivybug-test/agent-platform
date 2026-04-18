import {
  pgTable,
  uuid,
  text,
  timestamp,
  varchar,
  boolean,
  pgEnum,
} from "drizzle-orm/pg-core";

// Enums
export const memberTypeEnum = pgEnum("member_type", ["user", "agent"]);
export const senderTypeEnum = pgEnum("sender_type", ["user", "agent", "system"]);
export const messageStatusEnum = pgEnum("message_status", [
  "sending",
  "streaming",
  "completed",
  "failed",
]);

// Users
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Invite codes
export const inviteCodes = pgTable("invite_codes", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  usedBy: uuid("used_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  usedAt: timestamp("used_at"),
});

// Agents
export const agents = pgTable("agents", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  systemPrompt: text("system_prompt"),
  model: varchar("model", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Rooms
export const roomStatusEnum = pgEnum("room_status", ["active", "archived"]);

export const rooms = pgTable("rooms", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  systemPrompt: text("system_prompt"),
  status: roomStatusEnum("status").notNull().default("active"),
  autoReply: boolean("auto_reply").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Room members
export const roomMembers = pgTable("room_members", {
  id: uuid("id").defaultRandom().primaryKey(),
  roomId: uuid("room_id")
    .notNull()
    .references(() => rooms.id),
  memberId: uuid("member_id").notNull(),
  memberType: memberTypeEnum("member_type").notNull(),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
});

// Messages
export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  roomId: uuid("room_id")
    .notNull()
    .references(() => rooms.id),
  senderType: senderTypeEnum("sender_type").notNull(),
  senderId: uuid("sender_id"),
  content: text("content").notNull().default(""),
  contentType: varchar("content_type", { length: 50 }).notNull().default("text"),
  status: messageStatusEnum("status").notNull().default("completed"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Friendships
export const friendshipStatusEnum = pgEnum("friendship_status", [
  "pending",
  "accepted",
]);

export const friendships = pgTable("friendships", {
  id: uuid("id").defaultRandom().primaryKey(),
  requesterId: uuid("requester_id")
    .notNull()
    .references(() => users.id),
  addresseeId: uuid("addressee_id")
    .notNull()
    .references(() => users.id),
  status: friendshipStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Memory enums
export const memoryCategoryEnum = pgEnum("memory_category", [
  "identity",
  "preference",
  "relationship",
  "event",
  "opinion",
  "context",
]);

export const memoryImportanceEnum = pgEnum("memory_importance", [
  "high",
  "medium",
  "low",
]);

export const memorySourceEnum = pgEnum("memory_source", [
  "extracted",
  "user_explicit",
]);

// User memories
// NOTE on the multi-user model (Phase 2):
//   user_id           = the SUBJECT (what/who the fact is about; the owner).
//   authored_by_user_id = who wrote this row.
//     NULL                  → self-authored or extracted from subject's own
//                              messages. Treated as auto-confirmed.
//     equals user_id        → explicit self-write. Same semantics as NULL.
//     != user_id            → a third party wrote this about the subject.
//                              Becomes "pending" until the subject accepts it.
//   confirmed_at      = when the subject accepted a third-party write.
//     NULL on third-party rows = pending; hide from pinned + tool reads.
// Use `visibleToSubject` in apps/web/src/lib/memory-filters.ts everywhere
// memories are read so the filter stays consistent.
export const userMemories = pgTable("user_memories", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  content: text("content").notNull(),
  category: memoryCategoryEnum("category").notNull().default("context"),
  importance: memoryImportanceEnum("importance").notNull().default("medium"),
  source: memorySourceEnum("source").notNull().default("extracted"),
  sourceRoomId: uuid("source_room_id").references(() => rooms.id),
  authoredByUserId: uuid("authored_by_user_id").references(() => users.id),
  confirmedAt: timestamp("confirmed_at"),
  lastReinforcedAt: timestamp("last_reinforced_at"),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Room summaries
export const roomSummaries = pgTable("room_summaries", {
  id: uuid("id").defaultRandom().primaryKey(),
  roomId: uuid("room_id")
    .notNull()
    .references(() => rooms.id),
  content: text("content").notNull(),
  messageCount: varchar("message_count", { length: 20 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
