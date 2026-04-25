import {
  pgTable,
  uuid,
  text,
  timestamp,
  varchar,
  boolean,
  pgEnum,
  real,
  jsonb,
} from "drizzle-orm/pg-core";

export interface MessageMetadata {
  vision?: {
    caption: string;
    model: string;
    generatedAt: string;
  };
}

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
  // Side-channel for non-text artifacts attached to the message.
  // For image messages, `metadata.vision.caption` holds the asynchronously
  // generated caption that lets text-only LLMs still reference the image
  // after it scrolls out of the recent window.
  metadata: jsonb("metadata").$type<MessageMetadata>(),
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
  // Temporal memory (Phase A): when the fact happened (resolved from relative
  // references like "今天" / "yesterday" at write time). NULL for timeless facts
  // like identity / preferences. `strength` counts reinforcement events — when
  // a near-duplicate is seen again we bump this instead of creating a new row.
  // Together with `last_reinforced_at` they feed the read-path decay score.
  eventAt: timestamp("event_at", { withTimezone: true }),
  strength: real("strength").notNull().default(1.0),
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

// User relationships (Phase 4 of multi-user memory)
// Bidirectional confirmed edges between two users. Canonical order
// (a_user_id < b_user_id, lexical uuid compare) keeps one row per pair-kind.
// Whichever side has confirmed_by_* first becomes the proposer; the other
// side must accept. Only rows with BOTH sides confirmed feed the pinned
// prompt's "Known relationships" layer.
export const userRelationships = pgTable("user_relationships", {
  id: uuid("id").defaultRandom().primaryKey(),
  aUserId: uuid("a_user_id")
    .notNull()
    .references(() => users.id),
  bUserId: uuid("b_user_id")
    .notNull()
    .references(() => users.id),
  kind: varchar("kind", { length: 40 }).notNull(),
  content: text("content"),
  confirmedByA: timestamp("confirmed_by_a"),
  confirmedByB: timestamp("confirmed_by_b"),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Room-shared memories (Phase 3 of multi-user memory)
// Facts that belong to the ROOM, not any single user. Project codenames,
// group focus, shared agreements. Any room member can add / edit / delete.
// Agent reads them through a Room context layer in buildSystemPrompt.
export const roomMemories = pgTable("room_memories", {
  id: uuid("id").defaultRandom().primaryKey(),
  roomId: uuid("room_id")
    .notNull()
    .references(() => rooms.id),
  content: text("content").notNull(),
  importance: memoryImportanceEnum("importance").notNull().default("medium"),
  createdByUserId: uuid("created_by_user_id")
    .notNull()
    .references(() => users.id),
  source: memorySourceEnum("source").notNull().default("extracted"),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
