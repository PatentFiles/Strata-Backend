import { pool } from "@workspace/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SESSION_QUERY_TIMEOUT_MS = 3000;
type Query = { text: string; values?: unknown[]; query_timeout: number };
type Client = {
  query: (query: Query) => Promise<{ rows: Array<Record<string, unknown>> }>;
  release: (destroy?: boolean) => void;
};
type Pool = { connect: () => Promise<Client> };
const deny = (reason: string) => ({
  ok: false as const, reason, policyApproved: false as const,
  commissioningApproved: false as const, tradingAuthorized: false as const,
});
export const SESSION_ADMIN_SQL = `
 SELECT EXISTS (
  SELECT 1 FROM auth.users u
  JOIN private.role_assignments r ON lower(btrim(r.email))=lower(btrim(u.email))
  WHERE u.id=$1::uuid AND u.email_confirmed_at IS NOT NULL AND r.role='ADMIN'
 ) AS is_admin`;

// Fixed catalog targets only. These functions inspect ACLs, never table contents.
export const SESSION_RELATIONS = [
  "public.v13_production_account",
  "public.v13_production_intent",
  "public.v13_production_position",
  "public.v13_production_event",
  "private.kalshi_account_worker_lease",
  "private.strata_emergency_exit_reservations",
  "private.strata_protective_exit_release",
  "private.strata_owner_sha_approvals",
] as const;
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE"] as const;
export const RUNTIME_DB_SESSION_SQL = `
 SELECT current_user::text AS current_role,
        session_user::text AS session_role,
        pg_catalog.current_setting('search_path') AS search_path,
        pg_catalog.current_setting('session_replication_role') AS replication_role,
        pg_catalog.current_setting('row_security') AS row_security,
        (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS superuser,
        (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user) AS bypass_rls,
        pg_catalog.has_schema_privilege(current_user,'private','USAGE') AS schema_usage,
        ${SESSION_RELATIONS.flatMap((table, i) => [
          `pg_catalog.to_regclass('${table}') IS NOT NULL AS relation_${i}_exists`,
          ...PRIVILEGES.map(privilege => `coalesce(pg_catalog.has_table_privilege(current_user,pg_catalog.to_regclass('${table}'),'${privilege}'),false) AS relation_${i}_${privilege.toLowerCase()}`),
        ]).join(',\n        ')}
`;
const boundedText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

/** Observation on one actual API pool connection, not an identity fingerprint.
 * Existing confirmed-ADMIN gate is the only application-row read. Callers must
 * enforce AAL2. query_timeout bounds client waits; errors destroy the checkout
 * rather than returning a possibly busy connection. No SET or session mutation.
 * Pool acquisition retains the pool's configured connectionTimeoutMillis.
 * ACL flags do NOT prove RLS visibility, effective write ability or approval.
 */
export async function inspectRuntimeDbSession(actorId: string, db: Pool = pool) {
  if (!UUID.test(actorId)) return deny("authentication_subject_invalid");
  let client: Client | undefined;
  let destroy = false;
  try {
    client = await db.connect();
    const allowed = await client.query({text: SESSION_ADMIN_SQL, values: [actorId], query_timeout: SESSION_QUERY_TIMEOUT_MS});
    if (allowed.rows.length !== 1 || allowed.rows[0]?.is_admin !== true)
      return deny("confirmed_administrator_required");
    const result = await client.query({text: RUNTIME_DB_SESSION_SQL, query_timeout: SESSION_QUERY_TIMEOUT_MS});
    if (result.rows.length !== 1) return deny("runtime_db_session_invalid");
    const row = result.rows[0]!;
    const booleanKeys = ["superuser", "bypass_rls", "schema_usage", ...SESSION_RELATIONS.flatMap((_, i) =>
      [`relation_${i}_exists`, ...PRIVILEGES.map(p => `relation_${i}_${p.toLowerCase()}`)])];
    if (!boundedText(row.current_role, 128) || !boundedText(row.session_role, 128) ||
        (row.search_path !== "" && !boundedText(row.search_path, 4096)) ||
        (typeof row.replication_role !== "string" || !["origin", "replica", "local"].includes(row.replication_role)) ||
        (typeof row.row_security !== "string" || !["on", "off"].includes(row.row_security)) ||
        booleanKeys.some(key => typeof row[key] !== "boolean")) return deny("runtime_db_session_invalid");
    return {
      ...deny("read_only_runtime_database_session_observed"), ok: true as const,
      currentUser: row.current_role, sessionUser: row.session_role, searchPath: row.search_path,
      sessionReplicationRole: row.replication_role, rowSecurity: row.row_security,
      superuser: row.superuser, bypassRls: row.bypass_rls, privateSchemaUsable: row.schema_usage,
      tablePrivileges: SESSION_RELATIONS.map((relation, i) => ({
        relation, exists: row[`relation_${i}_exists`],
        select: row[`relation_${i}_select`], insert: row[`relation_${i}_insert`],
        update: row[`relation_${i}_update`],
      })),
    };
  } catch {
    destroy = true;
    return deny("runtime_db_session_unavailable");
  } finally {
    // Cleanup must not replace the sanitized result with a driver error.
    try { client?.release(destroy); } catch { /* never publish driver details */ }
  }
}
