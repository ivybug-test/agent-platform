import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { Sql } from "postgres";
import * as schema from "./schema.js";

// Cache the pool on globalThis so Next.js dev's HMR reloads don't keep
// creating new postgres pools on every route recompile (the old ones
// don't release their connections, and within a few minutes Postgres
// hits "sorry, too many clients already"). Production single-process
// node start hits this branch once and never again.
const GLOBAL_KEY = "__agent_platform_db";
type Cache = { sql: Sql; db: PostgresJsDatabase<typeof schema> };
declare global {
  // eslint-disable-next-line no-var
  var __agent_platform_db: Cache | undefined;
}

function init(): Cache {
  const cached = (globalThis as any)[GLOBAL_KEY] as Cache | undefined;
  if (cached) return cached;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  const sql = postgres(process.env.DATABASE_URL, {
    // Cap connections so even when the pool gets duplicated across
    // unexpected reloads we stay well below Postgres' default
    // max_connections=100. 8 is enough for the chat / polling load.
    max: 8,
    // Drop idle connections after 30s so dev server reloads don't
    // leak indefinitely.
    idle_timeout: 30,
  });
  const db = drizzle(sql, { schema });
  const next: Cache = { sql, db };
  (globalThis as any)[GLOBAL_KEY] = next;
  return next;
}

export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_, prop) {
    return (init().db as any)[prop];
  },
});

export const sql = new Proxy({} as Sql, {
  get(_, prop) {
    return (init().sql as any)[prop];
  },
});
