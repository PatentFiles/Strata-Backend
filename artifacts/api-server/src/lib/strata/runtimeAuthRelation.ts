/** Explicit opt-in relation selection for reviewed, code-owned SQL only.
 * This is not a pool interceptor, SQL sanitizer, query builder or identity
 * verifier. Never pass user-supplied SQL. All predicates, bound parameters and
 * FOR SHARE/UPDATE clauses are preserved; only the Auth relation changes.
 * The private bridge exposes four non-secret identity columns and read locks.
 * It grants no JWT validity, account ownership, consent or order permission.
 */
export function runtimeAuthSql(sql:string):string{
 return process.env.STRATA_RESTRICTED_RUNTIME_AUTH==='true'
  ?sql.replace(/\bauth\.users\b/g,'private.strata_runtime_auth_user_v1'):sql;
}
