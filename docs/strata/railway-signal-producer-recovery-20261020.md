# Strata production: recovery after Railway build outage

**Scope:** Existing Railway project `terrific-embrace`, service `Strata-Backend`, production environment. The signed-in account's execution worker is **separate** from the global V13 legacy worker and the PAPER_ONLY forward-test market-evaluation producer.

**This is a deployment/verification checklist, not trading authorization.** Do not use SQL UPDATE/INSERT, fabricate signals, change permissions, or replay an order to make a status indicator green.

## Verified cause (2026-10-20)

- The owner-scoped worker periodically reconciled Kalshi but had no qualifying strategy records to consume.
- `forward_test_engine` and `forward_test_evaluations` contained zero records.
- The producer requires **both** exact review approval `V13_ENTRY_POLICY_RUNTIME_APPROVED=<reviewed V13_ENTRY_POLICY_VERSION>` and `FORWARD_TEST_PRODUCTION_WORKER_ENABLED=true` when `NODE_ENV=production`. Development flags never permit production operation.
- The production-worker flag was added in Railway, but the existing container cannot inherit a new environment variable before a new deployment.
- Railway temporarily paused new deployments. **Setting a variable is not a successful deployment.** Do not restart the already-running personal worker during the outage.
- The personal protective-exit release is SHA-bound and time-limited. It must be valid for the deployed commit with >20 minutes remaining before it can authorize new entries.
- GitHub PR #110 (legacy global-account isolation) and #111 (startup reason logging) are review changes, not evidence of a deployed binary.

## P0 discovery after runbook creation — provisional commissioning freeze

**Do not enable owner-scoped new entries after the signal producer deploy until this has been resolved.**

The provisioning code persists `blocked_reason='awaiting_account_commissioning'`. The currently deployed commissioning/activation transitions do not clear it, even when `commissioned=true` and `execution_enabled=true`. The live `ProductionExecutor.gate` then rejects entry with `production_account_frozen`. A read-only inspection on 2026-10-20 found the stale sentinel on all **three commissioned personal accounts** (plus two correctly still-uncommissioned accounts).

- [Backend draft PR #112](https://github.com/PatentFiles/Strata-Backend/pull/112) corrects future valid commissioning transitions and surfaces the freeze in owner readiness. It does not silently repair already-enabled accounts.
- Existing commissioned accounts need independently reviewed, account-specific authenticated recovery, with owner/operator approval, immutable audit, exact identity/policy/fee verification, fresh complete Kalshi reconciliation and zero unresolved orders or exposure. Never clear genuine financial exception reasons.
- The old protective-exit release has expired. Renew only after choosing the final deployed backend SHA. Any cached `ARM` or healthy lease does not recreate entry authority after a release expires.
- Do **not** assume that the `FORWARD_TEST_PRODUCTION_WORKER_ENABLED` fix alone completes real-money readiness.

## Before choosing a deployment target

1. Check the existing Railway service and commit SHA, not just the repository's main branch. Confirm whether new deployments are genuinely available, whether pending staged changes exist, and whether the intended flags are deployed.
2. Review every backend PR proposed for the rollout. **A new backend commit invalidates release evidence bound to the prior deployed SHA.** Decide whether to first deploy the existing reviewed commit with its updated environment or to release a newly reviewed commit, then commission that exact SHA.
3. Read the authenticated Kalshi production subaccount's positions, orders, fills, settlements, and balance. Reconcile them with the backend account before any restart/START.
4. Verify that there are no unknown or dispatched unresolved orders, unexplained cash movements, stale credentials, active account/global kill switches, or maintenance holds.
5. Use the authenticated Step 12 workflow to qualify the **exact selected backend version**, complete the genuine independent review, and obtain the owner's specific authorization. Do not insert, edit, or extend approval rows manually.
6. If there is existing exposure, preserve protective-exit management: schedule a coordinated maintenance window rather than stopping or redeploying abruptly.

## After Railway builds resume

1. Deploy the reviewed target to the existing `terrific-embrace / Strata-Backend` service. Do **not** create a duplicate trading service or a second replica.
2. Confirm the new deployment status is `SUCCESS`, the replica is healthy, and the code SHA matches the release evidence. Review structured startup logs: `production_signal_worker_disabled`, `entry_policy_approval_missing`, `entry_policy_approval_mismatch` and `unsupported_environment` explain why PAPER_ONLY evaluations are not scheduled. A `ready` scheduler log is *not* confirmation that a market evaluation succeeded.
3. Confirm `forward_test_engine` exists, `enabled=true`, the worker lease is current, and `last_successful_cycle_at` and `last_evaluation_at` are recent. If the engine reports a public Coinbase/Kalshi feed failure, diagnose the feed; do not manufacture a qualifying evaluation.
4. Ensure a genuine `forward_test_evaluations` row is being created during healthy market cycles. There may be **zero qualifying signals** during normal markets; this is not by itself a defect.
5. Confirm full authenticated Kalshi reconciliation, exact approved policy and stake, fresh monetary fee evidence, release SHA/expiry, and no unresolved exposure. Then have the account owner separately **ARM** and **START** through the authenticated Strata controls. Neither flag setting nor paper signals grant live order authority.
6. For an actual qualifying signal, verify the decision gates and owner-scoped transaction/reconciliation chain: prepared intent, idempotent signed submission, exchange acknowledgement, partial fills, position updates and settlement. Do not issue a forced live-money test order merely to produce a fill.
7. Preserve fail-closed behavior on any deviation. Do not clear a kill switch, rewrite blocked reasons, or backfill missing paper evaluations to trigger entries.

## Read-only SQL triage (Supabase SQL editor)

Replace `<EXECUTION_ACCOUNT_ID>` with the exact ID returned by the authenticated account lookup. These queries intentionally perform no writes.

```sql
select now() checked_at,
       id, commissioned, execution_enabled, kill_switch, blocked_reason,
       cash_micros, reserved_micros, reconciled_at
from public.v13_production_account
where id = '<EXECUTION_ACCOUNT_ID>';

select now() checked_at, state, arm_requested, account_kill, heartbeat_at,
       extract(epoch from (now() - heartbeat_at)) as heartbeat_age_seconds
from private.kalshi_account_worker_lease
where execution_account_id = '<EXECUTION_ACCOUNT_ID>';

select id, enabled, lease_expires_at, last_successful_cycle_at,
       last_evaluation_at, current_reason, last_error
from public.forward_test_engine
order by updated_at desc limit 5;

select count(*) as total_evaluations,
       max(evaluated_at) as newest_evaluation,
       count(*) filter (where evaluated_at > now() - interval '5 minutes') as recent_evaluations,
       count(*) filter (where qualifying_trigger and fresh_cross
           and signal in ('SCOUT','CONFIRM')
           and evaluated_at > now() - interval '5 minutes') as recent_qualifying
from public.forward_test_evaluations;

select state, count(*) from public.v13_production_intent
where account_id = '<EXECUTION_ACCOUNT_ID>' group by state;

select release_commit_sha, state, expires_at,
       (expires_at > now() + interval '20 minutes') as meets_startup_window
from private.strata_protective_exit_release
where revoked_at is null
order by created_at desc limit 3;
```

**Completion criterion:** Railway deployment health + exact reviewed SHA + fresh signal-producing cycles + authenticated full exchange reconciliation + valid release for the deployed SHA + explicit owner ARM and START + correct handling of any genuine qualifying event. Paper-only signal activity and a personal worker heartbeat **alone** are insufficient to declare live trading operational.


## Release validity: precise semantics and recommended follow-up

- The **release lives for two hours**: the reviewed owner approval transaction inserts `expires_at=now()+interval '2 hours'`.
- The **20-minute threshold is a remaining-validity margin**, not a demand for new source code or independent review every 20 minutes: personal START and every worker snapshot need `expires_at > now()+interval '20 minutes'`.
- The final protective-exit signed POST verifies **the same exact SHA-bound release** with `expires_at>now()`, preserving a late-expiry safety check. Do not extend expiration in the database or remove its final-order fence.
- After remaining validity dips under 20 minutes, new entries are latched off in the running session. A new release alone cannot reactivate that session: explicit authenticated restart with full reconciliation is necessary.
- The expiring approval is an **operational policy friction**, but not proof the 20-minute margin is a code defect. A future reviewed policy design should separate persistent code-review authorization (SHA, review evidence, revocation) from shorter-lived, automatically verified operational readiness (fees, account, policy, recon, lease, position, protective-exit capacity). Reauthorizing actual live-money trading remains an explicit owner decision, not an automated review forgery.
- **P0 review question:** a final protective-exit attempt is itself gated by the expiration. Before changing the two-hour policy, validate positions that remain open across expiry and prove there is a safe, independently authorized reduce-only exit path that does not inadvertently strand exposure. Preserve all one-use transport, unknown-order recovery and independent review controls.
- A release is approved **only for the actual deployed SHA**, not for a draft PR's current tip or a candidate assembled while the previous binary runs.
- The existing commissioned-account freeze is separate from release expiry: PR #112 prevents future stale sentinel states, but an already-enabled account cannot be silently repaired. Recovery requires a controlled, authenticated, owner-confirmed, auditable action after independent review and zero-exposure checks. No generic SQL clear is approved.

## Deployment gate decision

**NO-GO** until all checks pass: consolidated CI; genuine independent review; a safe, audited precommissioning-sentinel remediation for already-commissioned accounts; healthy Railway deployment and exact SHA; approved protective-exit release; live market-evaluation writes; authenticated Kalshi cash/position reconciliation; separate owner ARM and START; proper real order/partial-fill/unknown-response settlement handling. A fresh worker heartbeat alone is insufficient.
