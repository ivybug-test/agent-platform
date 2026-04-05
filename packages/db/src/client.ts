import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { Sql } from "postgres";
import * as schema from "./schema.js";

let _sql: Sql | null = null;
let _db: PostgresJsDatabase<typeof schema> | null = null;

function init() {
  if (!_db) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    _sql = postgres(process.env.DATABASE_URL);
    _db = drizzle(_sql, { schema });
  }
  return { db: _db, sql: _sql! };
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
