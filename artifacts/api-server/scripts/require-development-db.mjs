/**
 * Fail closed before any isolated test creates a schema or writes test data.
 * These identifiers were compared against Replit's explicitly targeted
 * development and production read-only database queries on 2026-09-25.
 * They are hashes of database/server names, not connection credentials.
 * If the development database is replaced, re-verify both targets before
 * changing this pin; never pass an override flag to a test command.
 */
import { VERIFIED_DEVELOPMENT, VERIFIED_PRODUCTION } from "../../../lib/db/src/verified-destinations.mjs";
export { classifyDatabaseDestination } from "../../../lib/db/src/verified-destinations.mjs";

const DESTINATION_QUERY = `
  SELECT current_database() AS database_name,
    current_user AS database_user,
    md5(current_database()) AS database_name_hash,
    md5(coalesce(inet_server_addr()::text, 'local') || ':' ||
      coalesce(inet_server_port()::text, '?')) AS server_endpoint_hash,
    (SELECT oid FROM pg_database WHERE datname = current_database()) AS database_oid,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'micro_live_orders' AND column_name = 'cancellation_attempted_at')
      AS has_claim_column,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'micro_live_config' AND column_name = 'micro_live_reserved_micros')
      AS has_budget_column
`;

function githubActionsEphemeralDestination(row) {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.CI !== "true" ||
      process.env.NODE_ENV !== "test" || !process.env.DATABASE_URL) return false;
  let url;
  try {
    url = new URL(process.env.DATABASE_URL);
  } catch {
    return false;
  }
  const localHost = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return url.protocol === "postgresql:" &&
    localHost && (url.port === "" || url.port === "5432") &&
    databaseName === "v13_ci" &&
    row?.database_name === "v13_ci" &&
    row?.database_user === "postgres" &&
    row?.has_claim_column === true &&
    row?.has_budget_column === true;
}

export function assertVerifiedDevelopmentDestination(row) {
  const verifiedDevelopment = Boolean(row &&
    row.database_name_hash === VERIFIED_DEVELOPMENT.databaseNameHash &&
    row.server_endpoint_hash === VERIFIED_DEVELOPMENT.serverEndpointHash &&
    Number(row.database_oid) === VERIFIED_DEVELOPMENT.databaseOid &&
    row.has_claim_column === true && row.has_budget_column === true);
  const knownProduction = Boolean(row &&
    row.database_name_hash === VERIFIED_PRODUCTION.databaseNameHash &&
    Number(row.database_oid) === VERIFIED_PRODUCTION.databaseOid);
  if (knownProduction || (!verifiedDevelopment && !githubActionsEphemeralDestination(row))) {
    throw new Error("Refusing database-backed tests: destination is not the verified development database");
  }
}

export async function requireDevelopmentDatabase(client) {
  if (process.env.REPLIT_DEPLOYMENT === "1") {
    throw new Error("Refusing database-backed tests in a deployed production process");
  }
  const { rows } = await client.query(DESTINATION_QUERY);
  if (rows.length !== 1) {
    throw new Error("Refusing database-backed tests: database destination could not be verified");
  }
  assertVerifiedDevelopmentDestination(rows[0]);
}