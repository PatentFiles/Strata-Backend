import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

/** node-postgres pool for a long-lived process. SSL follows the URL; local URLs stay plain. */
export function poolConfig(connectionString: string): pg.PoolConfig {
  const url = new URL(connectionString);
  const sslmode = url.searchParams.get("sslmode");
  const config: pg.PoolConfig = {
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
  if (sslmode === "require" || sslmode === "prefer") {
    url.searchParams.delete("sslmode");
    config.connectionString = url.toString();
    config.ssl = { rejectUnauthorized: false };
  } else if (sslmode === "verify-ca" || sslmode === "verify-full") {
    url.searchParams.delete("sslmode");
    config.connectionString = url.toString();
    config.ssl = { rejectUnauthorized: true };
  }
  return config;
}

export const pool = new Pool(poolConfig(process.env.DATABASE_URL));
export const db = drizzle(pool, { schema });
export type { Pool, PoolClient } from "pg";

export * from "./schema";
