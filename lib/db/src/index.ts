import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import {installPoolCheckoutTiming} from "./poolCheckoutTiming";
export {PoolCheckoutTimingCapture,installPoolCheckoutTiming} from "./poolCheckoutTiming";
export type {PoolCheckoutTiming} from "./poolCheckoutTiming";
import { observeIdlePoolErrors } from "./poolErrors";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

import {poolConfig} from './poolConfig';
export {poolConfig} from './poolConfig';

export const pool = new Pool(poolConfig(process.env.DATABASE_URL));
installPoolCheckoutTiming(pool);
observeIdlePoolErrors(pool);
export const db = drizzle(pool, { schema });
export type { Pool, PoolClient } from "pg";

export * from "./schema";
