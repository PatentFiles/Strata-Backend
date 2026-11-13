/**
 * PostgreSQL count(*)::text must be exactly one canonical unsigned decimal
 * and fit in JS's safe integer range. Missing/ambiguous evidence is NEVER zero.
 */
export function verifiedUnresolvedIntentMode(rows: unknown):
  {ok:true;mode:"entries"|"recovery"} |
  {ok:false;reason:"unresolved_intent_count_unverified"} {
  if (!Array.isArray(rows) || rows.length !== 1 ||
      rows[0] === null || typeof rows[0] !== "object" ||
      Array.isArray(rows[0])) {
    return {ok:false,reason:"unresolved_intent_count_unverified"};
  }
  const n = (rows[0] as Record<string,unknown>).n;
  if (typeof n !== "string" || !/^(0|[1-9][0-9]*)$/.test(n) ||
      !Number.isSafeInteger(Number(n))) {
    return {ok:false,reason:"unresolved_intent_count_unverified"};
  }
  return {ok:true,mode:n==="0"?"entries":"recovery"};
}

/** Treat database failures as missing evidence; never infer entry authority.
 * Include BOTH normal production intents and protective exit reservations:
 * an unresolved exit can already have consumed its one-use client order ID
 * even when no v13_production_intent row exists.
 */
export async function readUnresolvedIntentMode(
  query: (sql: string, params: unknown[]) => Promise<{rows:unknown}>,
  accountId: string,
  /** Server-only current final-fence claim; never supplied by an HTTP request. */
  currentEntryIntentId: string | null = null,
): Promise<ReturnType<typeof verifiedUnresolvedIntentMode>> {
  try {
    const result = await query(
      `WITH unresolved_intents AS (
         SELECT count(*)::text AS n FROM v13_production_intent
         WHERE account_id = $1 AND state IN ('DISPATCHED','UNKNOWN')
           AND ($2::text IS NULL OR id <> $2 OR kind <> 'ENTRY' OR state <> 'DISPATCHED')
       ), unresolved_exits AS (
         SELECT count(*)::text AS n FROM private.strata_emergency_exit_reservations
         WHERE execution_account_id = $1
           AND state IN ('PREPARED','DISPATCHED','UNKNOWN')
       )
       SELECT (i.n::bigint + p.n::bigint)::text AS n
       FROM unresolved_intents i CROSS JOIN unresolved_exits p`,
      [accountId, currentEntryIntentId],
    );
    return verifiedUnresolvedIntentMode(result?.rows);
  } catch {
    return {ok:false,reason:"unresolved_intent_count_unverified"};
  }
}
