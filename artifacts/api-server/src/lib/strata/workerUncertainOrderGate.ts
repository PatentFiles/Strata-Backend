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
