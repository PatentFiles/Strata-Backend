/**
 * Non-secret destination fingerprints independently verified against explicit
 * development/production database targets on 2026-09-25. Reverify both targets
 * if the development database is replaced; never add a test override.
 */
export const VERIFIED_DEVELOPMENT = Object.freeze({
  databaseNameHash: "3674a53cdc4f6baa13fd11b18153eedf",
  serverEndpointHash: "e6cef578c7102f8739db4a57c25c29f2",
  databaseOid: 16384,
});
export const VERIFIED_PRODUCTION = Object.freeze({
  databaseNameHash: "1aad2780f5bf2f804f5c5f6de0e3969e",
  serverEndpointHash: "9d285fbb85820f09eb5f718a7091b5c3",
  databaseOid: 16394,
});

/** Reporting only; does not grant write permission or relax any test guard. */
export function classifyDatabaseDestination(row) {
  if (row?.database_name_hash === VERIFIED_DEVELOPMENT.databaseNameHash &&
      row?.server_endpoint_hash === VERIFIED_DEVELOPMENT.serverEndpointHash &&
      Number(row?.database_oid) === VERIFIED_DEVELOPMENT.databaseOid) return "DEVELOPMENT";
  if (row?.database_name_hash === VERIFIED_PRODUCTION.databaseNameHash &&
      row?.server_endpoint_hash === VERIFIED_PRODUCTION.serverEndpointHash &&
      Number(row?.database_oid) === VERIFIED_PRODUCTION.databaseOid) return "PRODUCTION";
  return "UNKNOWN";
}
