/**
 * V1 institutionally separated release gates.
 *
 * A) Exact, revocable, owner-scoped, independently reviewed code SHA.
 * B) Short-lived operational evidence (reconciliation, policy, account, risks).
 * C) Explicit owner ARM/START, kill switches and the one-use final signed fence.
 *
 * No implicit migration: the existing two-hour release remains authoritative
 * unless the explicitly reviewed Railway feature flag is exactly "true".
 */
export const INSTITUTIONAL_APPROVAL_FLAG="STRATA_INSTITUTIONAL_CODE_APPROVAL_ENABLED";
export type InstitutionalMode="LEGACY_TWO_HOUR"|"DURABLE_CODE_V1";

export function institutionalReleaseMode(env: NodeJS.ProcessEnv=process.env):InstitutionalMode {
  return env[INSTITUTIONAL_APPROVAL_FLAG]==="true"?"DURABLE_CODE_V1":"LEGACY_TWO_HOUR";
}

/** START and continuous new-entry gate: exact code + fresh account evidence. */
export const INSTITUTIONAL_ENTRY_SQL=`
 SELECT c.approval_id::text AS release_id
 FROM private.strata_durable_code_approvals c
 JOIN public.v13_production_account a ON a.owner_user_id=c.owner_user_id
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 JOIN public.live_execution_config g ON g.id='singleton'
 WHERE c.release_commit_sha=$1::text AND c.owner_user_id=$2::uuid
 AND c.revoked_at IS NULL
 AND c.independent_reviewer_id<>$2::uuid
 AND c.owner_approver_id=$2::uuid
 AND a.commissioned=true AND a.execution_enabled=true AND a.kill_switch=false
 AND a.blocked_reason IS NULL AND a.cash_precision_verified=true
 AND a.reconciled_at>now()-interval '15 seconds' AND a.reconciled_at<=now()
 AND a.subaccount=1 AND a.exchange_index=2 AND a.reserved_micros>=0
 AND a.fee_artifact_digest ~ '^[a-f0-9]{64}$'
 AND p.state='APPROVED'
 AND g.mode='V13_PRODUCTION' AND g.live_execution_enabled=true AND g.manual_kill_switch=false
 AND NOT EXISTS (SELECT 1 FROM public.v13_production_intent i
   WHERE i.account_id=a.id AND i.state IN ('DISPATCHED','UNKNOWN') AND i.terminal=false)
 LIMIT 2`;

/**
 * Reduce-only exit admission uses the SAME durable reviewed code, but must
 * not demand a fresh entry quote or a new qualifying market evaluation.
 * The existing signed-exit transaction independently enforces exact owner,
 * lease, position, fee, one-use marker and current global/account kill.
 */
export const INSTITUTIONAL_EXIT_JOIN=`
 JOIN private.strata_durable_code_approvals v
   ON v.release_commit_sha=$1 AND v.owner_user_id=a.owner_user_id`;
export const INSTITUTIONAL_EXIT_PREDICATE=`
 AND v.revoked_at IS NULL
 AND v.independent_reviewer_id <> a.owner_user_id
 AND v.owner_approver_id=a.owner_user_id`;

export const LEGACY_EXIT_JOIN=`
 JOIN private.strata_protective_exit_release v
   ON v.release_commit_sha=$1 AND v.state='approved'`;
export const LEGACY_EXIT_PREDICATE=`
 AND v.expires_at > now() AND v.revoked_at IS NULL
 AND v.independent_reviewer_id <> a.owner_user_id`;
