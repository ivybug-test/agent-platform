CREATE TYPE "public"."memory_source" AS ENUM('extracted', 'user_explicit');--> statement-breakpoint
ALTER TABLE "user_memories" ADD COLUMN "source" "memory_source" DEFAULT 'extracted' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_memories" ADD COLUMN "last_reinforced_at" timestamp;--> statement-breakpoint
ALTER TABLE "user_memories" ADD COLUMN "deleted_at" timestamp;