# Disposable restricted protective runtime qualification

This is a test-only candidate anchored to PR 322's source tree
`04ba03a2aacc7375ec20ee27e59289bc24b87350` (local parent commit `2847ab51`).
It is not a production grant manifest, tenant RLS design, or approval to change
runtime roles. Application SQL, runtime logic, and the canonical runner are unchanged.

## Qualification command and current evidence

Run `pnpm --filter @workspace/api-server run test:restricted-protective-runtime`.
The existing credential-stripped loopback runner creates a separate native
PostgreSQL cluster/process for each of three real full-schema supervisor scenarios:

1. Reconcile acknowledged UNKNOWN entry, issue two genuine reduced-only synthetic
   exits after a partial fill, persist both outcomes, and continue a later held tick.
2. Fail the final public read, persist durable no-send/VOID, transmit zero orders,
   and continue a later completed held tick.
3. Receive one ambiguous POST response, retain UNKNOWN, stop scheduling, and prove
   no further polling or retransmission.

The tests do not seed EXIT rows or replace the production ledger, executor, fee
verifier, signing checks, reservation, dispatch, reconciliation or scheduler.
Only external HTTP, upstream platform tables, an ephemeral RSA key, independent
approval rows, the already-acknowledged ENTRY boundary, and the paper-feed producer
are synthetic. Initial START is part of the exercised scenario; this is not a
ready-to-use held-only production credential.

Local source-contract tests and Node TypeScript syntax checks pass. Native PG
could not run locally: the canonical runner stops with
`PostgreSQL binaries required; no connected-database fallback exists` before
creating a cluster. Full workspace typecheck is also unrun locally because the
checkout has no installed dependencies. Hosted native execution and typecheck
must pass before claiming runtime compatibility. Earlier PR 322's green matrix
qualifies its own tests, not these new scenarios.

## Genuine runtime identity and narrow experiment

The full schema is installed after the existing URL plus actual-session fence.
All setup and external producer writes remain on a separate bootstrap pool.
Before production START, the original global pool is ended, including its idle
privileged sessions; its query/connect/end entry points are then bound to a real
LOGIN pool for `held_protective_runtime`. That role is nonowner, has no memberships,
and has no SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS. Both global
query and connect paths assert session_user/current_user. Production helpers that
ignore injected db ports therefore cannot retain a hidden bootstrap connection.
This adapter exists only in the test fixture, not in the application pool module.

`restrictedProtectiveRuntime.fixture.ts` is the executable explicit object list:
- SELECT on the exact legacy path relations below; no schema-wide grants.
- UPDATE only named accounting, intent, position, lease, reservation and audit
  progress columns. Account owner identity is not writable.
- INSERT only intents (RLS requires EXIT), events, observations, worker lease,
  exit reservations, outcome/no-send audit, signal audit/progress, and the balance
  read quota (UPDATE only next_slot_at). No account
  or position provisioning, human-approval INSERT, DELETE, TRUNCATE, DDL or role
  switching is granted.
- Exact EXECUTE on the quantity helper. No direct trace-function EXECUTE or
  sequence grants. Real telemetry inserts explicitly test identity generation.
- Exact identity-column UPDATE on thirteen existing-RLS, lock-only relations.
  A permissive UPDATE USING(true) policy allows the visibility needed by row
  locking; a RESTRICTIVE WITH CHECK(false) policy forbids actual updates even if
  a second permissive UPDATE policy is added. This unusual combination remains
  an experiment until native PostgreSQL proves it. Its constant policies model
  trusted service semantics across fixture rows, not authenticated tenant scope.

Authority probes demonstrate SELECT-only FOR SHARE failure; actual successful
FOR SHARE blocks a competing fixture revocation writer; matching valid/no-op
updates fail with SQLSTATE 42501 and an RLS error; an absent-row UPDATE returns
zero; invalid UUID input instead fails with 22P02. They separately deny owner
changes, revocation, approval insertion, ALTER OWNER and SET ROLE, and compare
all approval values afterward. These checks cannot independently authenticate a
caller and are not a substitute for production user/role authorization.

After each scenario, KILL must report success and leave a durable killed lease,
account_kill=true and arm_requested=false. KILL does not imply every already-running
optional audit has drained. Outcome assertions avoid global-count races. Optional
signal audit and one real signal-decision insert are explicitly awaited because
the production worker can catch their errors. Actual EXIT mutations must produce
trace rows through the existing non-callable SECURITY DEFINER triggers. A separate
rollback probe briefly adds a diagnostic SELECT policy limited to its unique trace
marker, sees the uncommitted row in the same transaction, rolls back the intent and
trace, then revokes that visibility. This diagnostic read is not in the runtime
capability list and cannot hide a missing trigger behind an old trace row.

## Scope that remains unqualified

The legacy held supervisor reads the six maintenance tables; it does not execute
the separate owner-accounting `lockIndependentActivity` path. This test grants
those tables SELECT only and refuses to add lock UPDATE capabilities or silently
enable fixture RLS. The source fixture lacks RLS on pilot transfers and shard
allocations. A separately reported bounded production catalog observation found
RLS enabled there; that is a source/fixture difference, not evidence of a current
production RLS omission. Auth fixture rows also lack RLS, while the reported
production auth.users has RLS and a different platform owner. public.profiles is
absent from the fixture but reportedly exists with two production policies.
No production data or policy definitions are copied into these tests.

Still required before any restricted production pool rollout: standing successor
fee authority and its Auth/profile locks; short technical lease renewal versus
human delegation changes; explicit owner-accounting recovery with six independent
writer races; prepared-restart and ambiguous commit recovery; missing/revoked
privileges and stale lease/credential/review races; real platform Vault dependency
and secret scope; HTTP authentication and human approval writers on a separate
verified identity; and actual deployed pool/proxy mode. The current role cannot
replace the shared API/worker credential without breaking unqualified API routes.
Preserve existing protective operation while proving these branches. Any runtime
role/grant/security change requires separate review and authorization.

## Signed balance quota qualification correction

The first hosted run reached the restricted START boundary but returned
`kalshi_read_failed`. Source inspection identified an omitted dependency:
`kalshiAccountClient.ts:460-464` calls `reserveKalshiBalanceReadSlot` before
synthetic HTTP when production mode uses the global fetch identity. That helper
uses the global database pool to SELECT the credential owner and INSERT/upsert
`private.strata_kalshi_balance_read_slots`, updating only `next_slot_at`.
Migration `0027_strata_balance_quota_auto_maintenance.sql:3-9` creates the table,
revokes PUBLIC and enables RLS. The initial candidate provided no quota access.
This explains a concrete permission failure; it is not a provider outage finding.

The fixture now includes this exact operational table in its explicit read/insert
list and grants UPDATE only on `next_slot_at`, with ordinary test-only runtime
policies. A native probe removes INSERT, expects SQLSTATE 42501 from the real
quota function, restores INSERT, then calls the function twice and verifies an
insert followed by an advancing upsert. Changing `budget_key` remains denied.
The quota function, real spacing, signed reader and start-success expectation are
unchanged. Hosted requalification is required; static checks alone do not prove
the corrected native scenarios pass. No human-authority grants were broadened.

## Source-supported permission inventory

References below use `S/` for `artifacts/api-server/src/lib/strata/`, `V/` for `artifacts/api-server/src/lib/v13-production/`.

## Findings that affect the restricted fixture

1. **Read-only authority at the application level is not SELECT-only at the PostgreSQL ACL level.** Current code deliberately uses `SELECT ... FOR SHARE` on approval records and, for standing successor authority, Auth and administrator-role records. PostgreSQL requires SELECT on the referenced columns and UPDATE privilege on at least one column of every row-locked relation. An empty result does not remove that privilege requirement. Do not repair this with blanket UPDATE grants. The proposed fixture-only experiment of a narrow identity-column UPDATE ACL plus RLS `USING(true) WITH CHECK(false)` needs native proof for successful locking, denied no-op and changed updates, revoked/missing policies, and unchanged authoritative values. It is not a production permission design.
2. **Read dependencies include credentials and Vault.** The real supervisor reads `vault.decrypted_secrets.decrypted_secret`; the source-qualified fixture substitutes a simple table containing an ephemeral key. It proves neither deployed Vault view/function privileges nor the safety of broad decrypted-secret access.
3. **Invoked helper and trigger dependencies are essential.** `private.strata_exit_request_quantity_hundredths(jsonb)` is directly called by reserve/mark/final/no-send SQL and by an invoker trigger. It needs EXECUTE for the invoker. The no-send and reservation-transition triggers perform additional reads under the runtime identity. The four trace functions are SECURITY DEFINER and should remain non-callable directly by the runtime.
4. **Separate pools are not implemented by merely injecting a pool into the supervisor.** Several reserve/dispatch/fee/reconciliation helpers still use the global pool. The existing full supervisor fixture sets every global pool connection to the owner role, masking omissions. Qualify every fallback using the restricted global runtime identity; do not leave hidden owner connections.
5. **Technical renewal is an actual runtime write, unlike human authority creation.** `apiFeeStandingDelegation.CONTINUE_SQL` updates only `strata_api_fee_standing_delegations.lease_expires_at`. `renewContinuousTechnicalLease` upserts a separate short lease and inserts a technical audit event. These branches are not exercised by the full held supervisor's legacy grant seed and must not be confused with permission to issue/revoke/alter human grants.

## Test-to-production entry points and fixture limitations

| Test | Production entry points | Important qualification limit |
|---|---|---|
| `heldSupervisorDispatch`, `heldSupervisorNoSend`, `heldSupervisorAmbiguous` | Shared `heldSupervisorDispatch.postgres.fixture.ts:215-306`; `createProductionPersonalSession` (`personalExecutionSupervisor.ts:208`), `openOwnedExecutionSession`, `ProductionWorker`, `ProductionLedger`, `prepareExit`, reserve, mark UNKNOWN, final signed dispatch, outcome/restart reconciliation | Full unchanged application SQL manifest, but the existing fixture sets global sessions to owning `unknown_recovery_backend` at :229-232. Fixture-created approvals, credential, Vault row, source refresh and acknowledged ENTRY are setup, not worker write requirements. `NODE_ENV=production` at :235 intentionally exercises actual startup approval checks. |
| `reviewedProtectiveExitFee.postgres.test.ts` | `verifyReviewedProtectiveExitFeeAuthority` (`reviewedProtectiveExitFee.ts:136`) | :18-30 creates minimal, intentionally constraint-free tables; not the application migration chain. Owner/superuser-created table calls, fabricated approval rows and negative mutations do not prove restricted authority. |
| `protectiveActualAuthorityDispatch.postgres.test.ts` | Real fee verifier twice, `markOwnedEmergencyExitUnknownForReview`, `dispatchReviewedProtectiveExitOnce` | :24-35 creates minimal tables; :60 onward creates more stubs and imports just the quantity helper from SQL. Fake provider/signing boundary tests are valuable but do not prove real trigger/RLS/constraint/Vault behavior. |
| `heldReconciliationFence.postgres.test.ts` | `ProductionLedger.reconcileHeld`, `createUnknownEntryHeldFence`, `persistAuthenticatedExitReconciliation`, `reconcileUnknownProtectiveExitAfterRestart`, `reconcileOwnedProtectiveExits`, `recoverPreparedOwnedExitIntents` | Full manifest, owner-role fixture. Explicit fixture changes to policies/credentials/lease state are adversarial writers, not worker authority. |
| `ownerUnknownRecoverySchema.postgres.test.ts` | `fenceOwnerUnknownForAccounting`, `createHeldUnknownAccountingRecovery`, `ProductionLedger.reconcile` | Full manifest, owner-role fixture. Constraint removal, trigger disablement, DDL and immutable-history UPDATE/DELETE probes are privileged test setup/adversarial checks; runtime must not receive those privileges. Owner-assertion tests need to be separated from restricted execution assertions. |

## Actual runtime DML, separated from lock-only capability

All relations below need schema USAGE and the appropriate row policies if non-owner runtime identity is used. The existing source frequently uses `SELECT *`; a truly minimal SELECT-column ACL cannot be narrower than that query without a code change. SELECT also covers every predicate, JOIN, RETURNING and conflict target used by the specific statement, not only its output columns. No blanket DELETE, TRUNCATE, CREATE, trigger-disable, role-switch, ownership or BYPASSRLS privilege follows from this inventory.

| Relation | Required use in bounded flow | Actual written columns and sources |
|---|---|---|
| `private.strata_kalshi_balance_read_slots` | SELECT quota key/slot; INSERT/upsert before signed balance HTTP | INSERT `budget_key,next_slot_at`; UPDATE only `next_slot_at` (`kalshiBalanceQuota.ts:40-51`). Credential owner lookup at :28-36 uses existing credential SELECT. No quota-key mutation, DELETE, table ownership or DDL. |
| `public.v13_production_account` | SELECT all (ledger), account-first FOR UPDATE, final FOR SHARE | Worker accounting UPDATE `cash_micros,reserved_micros,blocked_reason,revision,reconciled_at,evidence_digest` (`ledger.ts:185-194,574-589`). Owner-confirmed safety fence additionally UPDATE `kill_switch,execution_enabled,revision` (`ownerUnknownRecoveryFence.ts:73-76`). No account INSERT in this held-exit lifecycle; account provisioning is separate. |
| `public.v13_live_money_policy` | SELECT all through `OwnedAccountLedger.policy`; FOR SHARE; reads authority/fee/policy state | No policy mutation by these worker/recovery functions. `accountProductionSession.ts:89-99`, `reviewedProtectiveExitFee.ts:43-127`. Lock-only UPDATE capability is a separate issue, not policy-approval authority. |
| `public.v13_production_intent` | SELECT all / history; FOR UPDATE and FOR SHARE | EXIT INSERT `id,account_id,parent_id,kind,market,side,request,decision,policy_hash,fee_fingerprint,capability_digest,client_order_id,reserved_micros,exit_fee_micros` (`executor.ts:352-405`). Reconciliation UPDATE `state,exchange_order_id,filled_hundredths,reserved_micros,terminal` (`ledger.ts:574-576`). UNKNOWN marker UPDATE `state,dispatch_at` (`ownerFeeEmergencyExitUnknownCommit.ts:181-188`). No-send UPDATE `state,terminal` (`ownerFeeEmergencyExitSignedDispatch.ts:169`). Generic ENTRY preparation/cancel paths have more columns and are outside a held protective-only scope. |
| `public.v13_production_position` | SELECT all; FOR UPDATE / final FOR SHARE | Reconciliation UPDATE `quantity_hundredths,basis_micros,realized_pnl_micros` (`ledger.ts:429-506`). No EXIT position INSERT. Test seeds the acknowledged ENTRY position; generic ENTRY creation inserts `id,account_id,market,side` (`executor.ts:335`), a separate entry capability. |
| `public.v13_production_event` | SELECT digest and aggregate `cash_delta_micros,pnl_micros` with account/intent/kind selectors | INSERT `account_id,event_id,intent_id,kind,digest,payload,cash_delta_micros,pnl_micros,occurred_at` (`ledger.ts:479-481,506-508`). No UPDATE/DELETE. Real event trigger writes trace under its definer. |
| `public.v13_production_observation` | SELECT `id,account_id,kind,payload,digest,observed_at` and activation/POST-attempt existence | INSERT `id,account_id,kind,payload,digest` (`ledger.ts:190-194`; `ownerUnknownRecoveryFence.ts:92`; `ownerUnknownRecoveryHeld.ts:221-224`). Observed timestamp default. Includes durable held receipts, owner kill and accounting receipts, transport observations and no-post proof. No UPDATE/DELETE. |
| `private.kalshi_account_worker_lease` | SELECT all required identity/state/heartbeat fields; FOR UPDATE and FOR SHARE | INSERT `execution_account_id,owner_user_id,financial_account_id,provider_connection_id,holder_id,fencing_token,state,heartbeat_at,released_at,account_kill,arm_requested,credential_fingerprint,vault_secret_id`; acquisition/arm/release/kill/heartbeat UPDATE subsets of those fields, excluding owner/account identity (`accountScopedExecution.ts:121-253`). Held operation writes only `arm_requested=false` (`unknownEntryRecoveryHold.ts:56`). Owner kill writes `state,account_kill,arm_requested,fencing_token,released_at,heartbeat_at` (`ownerUnknownRecoveryFence.ts:78-84`). START/control writes are distinct from ongoing restricted held-worker writes. |
| `private.strata_emergency_exit_reservations` | SELECT all in prepared-recovery; FOR UPDATE and final FOR SHARE | INSERT `reservation_id,owner_user_id,execution_account_id,market_ticker,client_order_id,reducing_side,quantity_hundredths,order_digest,worker_fencing_token,worker_holder_id,initial_position_fp,position_observed_at_ms,order_request_json,trading_authorized,state` (`ownerFeeEmergencyExitReserve.ts:135-144`). UPDATE only `state,updated_at` for PREPARED→UNKNOWN, UNKNOWN→RECONCILED, or audited no-send→VOID; also safe prepared-intent cleanup (`UnknownCommit.ts:164-172`, `ReconciliationCommit.ts:95-98`, `SignedDispatch.ts:171`, `preparedProtectiveExitRecovery.ts:66`). |
| `private.strata_protective_exit_reconciliations` | INSERT and SELECT RETURNING `reservation_id` | INSERT `reservation_id,owner_user_id,execution_account_id,client_order_id,market_ticker,evidence_sha256,filled_hundredths,remaining_hundredths,observed_position_fp` (`ownerFeeEmergencyExitReconciliationCommit.ts:83-90`). `reconciled_at` default. No UPDATE/DELETE. |
| `private.strata_protective_exit_local_no_send` | INSERT; SELECT by reservation-transition invoker trigger | INSERT `reservation_id,owner_user_id,execution_account_id,client_order_id,order_digest,worker_holder_id,worker_fencing_token,reason,evidence_sha256,signer_fingerprint,market_ticker,reducing_side,quantity_hundredths,limit_micros` (`ownerFeeEmergencyExitSignedDispatch.ts:164-167`). `recorded_at` default. No UPDATE/DELETE. |
| `public.forward_test_evaluations` | SELECT all in consumer/prepareExit; FOR SHARE in prepareExit | No worker UPDATE in these flows. The test's `evaluated_at` refresh is fake external producer setup, not required worker permission. `consumer.ts:21-27`, `executor.ts:365-366`. |
| `public.live_execution_config` | SELECT `id,live_execution_enabled,manual_kill_switch`; held/final FOR SHARE | No global gate changes by these flows. Test reset's enable flags are fixture-only. `personalExecutionSupervisor.ts:266-269`, `unknownEntryHeldFence.ts:30-36`, `ownerFeeEmergencyExitSignedDispatch.ts:232,278`. |
| `public.strata_configured_stake` | SELECT `execution_account_id,configured_stake_cents` at startup | No mutation in held-exit flow. Generic entry stake lock also reads `revision` and FOR UPDATE (`executor.ts:97-103`), outside held protective operation. `personalExecutionSupervisor.ts:131-140`. |

### Runtime reads that do not authorize mutation

* `private.kalshi_connection_credentials`: startup reads `owner_user_id,financial_account_id,provider_connection_id,role,vault_secret_id,key_fingerprint,revoked_at,verified_at,verification_reason`; held metadata locks the row. `id` is a possible narrow lock-capability column only if the separate experiment proves denying all actual credential mutation. `personalExecutionSupervisor.ts:120-149`, `unknownEntryHeldFence.ts:25-36`, `ownerUnknownRecoveryHeld.ts:37-51`.
* `vault.decrypted_secrets`: SELECT `id,decrypted_secret` in `personalExecutionSupervisor.SIGNER_SQL:120-149`. No direct Vault writes. `vault.secrets` is referenced by FK and setup only in this bounded runtime. The real view may transitively need extension/function access; the test's plain table cannot establish it.
* `public.financial_accounts`: SELECT `id,user_id,provider`, FOR SHARE in held metadata. `private.provider_connections`: SELECT `id,financial_account_id`, FOR SHARE. `ownerUnknownRecoveryHeld` additionally reads system `xmin` for these, credential, policy, account and lease rows, then hashes the revision binding (:37-51).
* Six independent-activity tables: `private.kalshi_owner_pilot_transfers`, `private.kalshi_owner_shard_allocations`, `private.kalshi_owner_topups`, `private.strata_auto_withdrawal_maintenance`, `private.strata_emergency_exit_reservations`, `private.strata_manual_profit_withdrawals`. SELECT `execution_account_id,state`; some startup guards also use `owner_user_id,id`. `lockIndependentActivity` locks ALL matching inactive and active child rows with FOR SHARE, selecting `execution_account_id` (`ownerUnknownRecoveryHeld.ts:70-103`). No transfer/withdrawal/topup mutation is required for accounting recovery. Reservations are separately mutable as above.
* `pg_catalog.pg_constraint`, `pg_class`, `pg_namespace`, `pg_attribute`, `pg_trigger`: catalog SELECT verifies six validated, immediate, nondeferrable account foreign keys and enabled INSERT/UPDATE FK triggers. `current_setting('session_replication_role')` must report `origin`. Removing the catalog checks or relaxing FK/trigger requirements is not a permission fix (`ownerUnknownRecoveryHeld.ts:83-101`).

## Human authority relations: exact reads and locks, no issuance authority

These fields are a union of the named current code paths, not a claim about every application route. INSERT, revocation UPDATE, expiry changes and identity/decision changes in fixtures are human-authority setup/adversarial operations, not writes needed by protective verification.

| Relation | Read columns | Lock participants |
|---|---|---|
| `private.strata_api_fee_source_grants` | `grant_id,owner_user_id,issuer_admin_id,rate_decision_digest,fee_model_version,scope,policy_version,confirmation,issued_at,expires_at,revoked_at,authorized_stages` | REVIEW, SUCCESSOR, API stage |
| `private.strata_api_fee_rate_reviews` | `review_id,owner_user_id,reviewer_user_id,rate_decision_digest,fee_model_version,scope,confirmation,signed_at,expires_at,revoked_at` | REVIEW, API stage |
| `private.strata_api_fee_owner_consents` | `consent_id,owner_user_id,grant_id,confirmation,confirmed_at,revoked_at` | REVIEW, API stage |
| `private.strata_api_fee_standing_models` | `model_id,reviewer_admin_id,rate_decision_digest,fee_model_version,scope,release_commit_sha,signed_at,valid_until,revoked_at` | SUCCESSOR |
| `private.strata_api_fee_standing_delegations` | `delegation_id,owner_user_id,model_id,grant_id,policy_hash,release_commit_sha,confirmation,granted_at,valid_until,revoked_at`; technical-renewal branch also `lease_expires_at` | SUCCESSOR; HISTORY itself is plain EXISTS |
| `private.strata_standing_execution_reviews` | `release_id,owner_user_id,execution_account_id,policy_hash,release_commit_sha,independent_reviewer_id,state,confirmation,created_at,revoked_at` | SUCCESSOR, standing final review and history |
| `private.strata_protective_exit_release` | `release_id,release_commit_sha,state,created_at,expires_at,revoked_at,independent_reviewer_id,operator_approver_id` | Startup and final legacy release lateral subquery |
| `private.strata_owner_sha_approvals` | `approval_id,owner_user_id,execution_account_id,release_commit_sha,revoked_at` | Startup; continuous eligibility/renewal |
| `private.strata_continuous_execution_grants` | `grant_id,owner_user_id,execution_account_id,release_commit_sha,policy_hash,reviewed_release_id,independent_reviewer_id,revoked_at` | Always-called history FOR SHARE; conditional continuous eligibility FOR SHARE and technical renewal FOR UPDATE |
| `auth.users` | `id,email,email_confirmed_at` | SUCCESSOR locks reviewer `u` AND issuer `issuer`; API stage uses plain EXISTS only |
| `private.role_assignments` | `email,role` | SUCCESSOR locks reviewer `role` AND issuer `issuer_role`; API stage uses plain EXISTS only |
| `public.profiles` | `id,role` | SUCCESSOR locks reviewer |

`private.strata_protective_release_qualification` is seeded to support owner approval foreign keys and human approval writes; the protective startup check does not read it directly. Its existence/immutable triggers matter to fixture setup, not a new worker SELECT/INSERT requirement.

Human writers include `recordStandingExecutionReview` / `revokeStandingExecutionReview` (`standingExecutionReview.ts:17-69`), standing fee model/delegation creation/revocation (`apiFeeStandingDelegation.ts` before :175 and after :240), and continuous owner enrollment/revocation (`continuousExecutionAuthorization.ts:25-124`). Do not include their writes merely because they share a module with runtime read/renewal functions.

### Exact row-lock map (lock-only identities are examples for experiments, not grants)

* `reviewedProtectiveExitFee.REVIEW_SQL:43-85`: SHARE `a=account,p=policy,g=source_grants,r=rate_reviews,c=owner_consents`.
* `reviewedProtectiveExitFee.SUCCESSOR_SQL:95-127`: SHARE `a,p,d=standing_delegations,m=standing_models,e=standing_execution_reviews,u=auth.users,role=role_assignments,reviewer=profiles,g=source_grants,issuer=auth.users,issuer_role=role_assignments`.
* `apiFeeSourceStage.READ_API_FEE_STAGE_SQL:50-89`: SHARE `g,c,r1`. Auth/role EXISTS reads are not row-locked there.
* `protectiveExitStartupRelease:9-30`: SHARE `v=protective_exit_release`; owner SHA query SHARE `oa` only. Joined account is not locked by that particular query.
* `standingExecutionReview:75-86`: final SHARE `r=standing_execution_reviews,p=policy`; history SHARE reviews even with zero matches.
* `continuousExecutionAuthorization:359-360`: SHARE continuous grants even if no standing history. Conditional `:162` SHARE `g,oa,r,w,l,p`; technical renewal `:300` UPDATE `g,w`, SHARE `r,oa,p,a` and `:318` UPDATE technical lease.
* `unknownEntryRecoveryHold:27-54`: UPDATE account, lease, target intent; SHARE policy, credentials, financial account, provider connection.
* `unknownEntryHeldFence:18-36`: UPDATE lease; SHARE policy, credentials, financial account, provider connection, live config. Native ledger already holds account UPDATE lock.
* `ownerUnknownRecoveryHeld:76-102,108,171-174`: SHARE each of the six dynamic activity relations; SHARE policy/credential/financial/provider in locked capture; UPDATE lease and all history intents. Native ledger account UPDATE lock persists for transaction.
* `ownerUnknownRecoveryFence:47-67`: UPDATE account, lease, target intent.
* `accountProductionSession:89-94`: SHARE policy only; full policy SELECT. `executor.prepareExit:363-366`: UPDATE position; SHARE source evaluation. `consumer:21-42`: UPDATE position after full reads.
* `ownerFeeEmergencyExitReserve:93-126`: UPDATE account then `a,w,pos,fi` (account, lease, position, financial intent). Global config only read here.
* `ownerFeeEmergencyExitUnknownCommit:112-154`: UPDATE account then `r,a,w,pos,fi` (reservation plus the foregoing). Global config only read here.
* `ownerFeeEmergencyExitSignedDispatch:138-161`: no-send UPDATE account, lease then `r,i,pos,parent`. Final `:246` SHARE legacy release, `:278` SHARE `r,a,g,w,pos,i,p` (reservation, account, global config, lease, position, intent, policy).
* `ownerFeeEmergencyExitReconciliationCommit:65-73`: UPDATE reservation only; account join is a read. `preparedProtectiveExitRecovery:38-46`: UPDATE position and reservation.
* Native ledger `ledger.ts:143-155,306,382,429,465,493,560`: account/intent/position UPDATE locks; policy SHARE at :177 for base ledger; full intent/position SELECTs remain.

Possible single columns for a *lock-only test ACL* are the relevant immutable identifier: `id`, `grant_id`, `review_id`, `consent_id`, `model_id`, `delegation_id`, `release_id`, `approval_id`, `execution_account_id`; `role_assignments` has `email` rather than an id. No uniqueness requirement follows merely from the lock privilege. Such ACLs must be paired with proven policy denial of actual writes, and cannot replace dynamic race tests.

## Conditional technical writes and observability

Not all of these execute in the listed test scenarios. They are production paths reachable from the same supervisor and must be qualified separately before pool cutover:

* `apiFeeStandingDelegation.ts:179-237`: real UPDATE ONLY `private.strata_api_fee_standing_delegations.lease_expires_at`, when the short legacy API source grant is no longer current and standing renewal is allowed. Reads account/policy, source grant, owner consent, original rate review, standing model, Auth users and role assignments. This is distinct from human `valid_until`, consent, SHA, policy-hash or revocation changes. Protective `verifyReviewedProtectiveExitFee` does **not** renew this lease.
* `continuousExecutionAuthorization.ts:228-349`: INSERT/UPDATE `private.strata_continuous_execution_technical_lease`: insert `grant_id,execution_account_id,observed_at,expires_at,evidence_digest,fencing_token,generation`; conflict UPDATE `observed_at,expires_at,evidence_digest,fencing_token,generation`. INSERT `private.strata_continuous_execution_audit(grant_id,execution_account_id,kind,evidence_digest,reason)` with kind `LEASE_RENEWED`. No continuous grant mutation by this renewal function, although it locks the grant FOR UPDATE.
* `signalDecisionTrace.ts:20-39`: INSERT `private.strata_v13_signal_decisions(execution_account_id,evaluation_id,phase,source_age_ms,reason,release_commit_sha)` with conflict DO NOTHING and RETURNING `decision_id`. No UPDATE/DELETE.
* `signalDecisionTrace.ts:81-139`: INSERT `private.strata_v13_signal_audit_progress(execution_account_id)`; SELECT/FOR UPDATE progress; SELECT trace scope `execution_account_id,started_at`, policy quote age/state, account and paper source fields; INSERT decision rows; UPDATE progress `cycle_cutoff,cursor_evaluated_at,cursor_evaluation_id,cycle_started_at,last_success_at,sources_examined,decisions_inserted,last_completed_cycle_at,completed_cycles` in corresponding branch. Optional sweep errors are caught/reported (`worker.ts:62-74`) and may not fail a trading assertion. A green held-supervisor test alone may therefore miss permission-denied telemetry.
* `private.strata_v13_signal_trace_scope` and `private.strata_v13_execution_trace` are written by definer triggers, not by direct worker calls in these flows. Owner test assertions reading trace do not imply the production worker needs direct SELECT on the execution trace.

## SQL functions, triggers, sequences and platform dependencies

### Invoker and direct helper

* `private.strata_exit_request_quantity_hundredths(jsonb)`: immutable STRICT invoker helper, `search_path=pg_catalog`; explicitly revoked from PUBLIC/anon/authenticated (`sql/strata_protective_exit_fractional_quantity.sql:7-29`). Needed by production reserve, UNKNOWN marker, final dispatch, local no-send check and the final no-send trigger. Do not infer access from schema USAGE or table rights.
* `private.strata_protective_exit_local_no_send_guard()`: attached BEFORE INSERT/UPDATE/DELETE, current body from fractional-quantity migration :32-65. Invoker reads reservations, account, intent twice (EXIT and parent), position, lease, and calls the helper. Runtime INSERT requires those reads and helper EXECUTE; no direct EXECUTE grant on the trigger function is implied by the installed trigger.
* `private.strata_emergency_exit_transition_guard()`: attached to reservations; replacement body in `sql/strata_protective_exit_local_no_send.sql:62-110` reads no-send audit and intent when testing UNKNOWN→RECONCILED/VOID. Losing audit SELECT blocks otherwise valid reconciliations, not merely no-send.
* `private.strata_protective_exit_baseline_guard()` (`strata_emergency_exit_baseline_private.sql:20-35`) and `private.strata_protective_exit_order_request_guard()` (`strata_protective_exit_request_snapshot_private.sql:22-36`) enforce immutable prepared baseline/request. No external SQL reads in those bodies.
* `private.strata_protective_exit_reconciliation_guard()` (`strata_protective_exit_reconciliation_private.sql:18-34`) rejects UPDATE/DELETE; not an INSERT authority grant.
* FK/unique/check/default constraints are active requirements, not rights the worker should administer. In particular account child FK INSERT/UPDATE locking is explicitly checked by held recovery. Runtime DML with existing FK does not imply permission to ALTER or disable constraints.

### Definer trace outbox

`lib/db/drizzle/0044_v13_signal_decision_trace.sql:32-40,56-126` defines four SECURITY DEFINER trigger functions with empty search_path, all direct EXECUTE revoked from PUBLIC/anon/authenticated/service_role:

* `private.strata_v13_begin_trace_scope()` inserts scope after account INSERT.
* `private.strata_v13_capture_intent()` reads parent intent as needed and inserts execution trace after intent INSERT/UPDATE.
* `private.strata_v13_capture_event()` reads intent/parent and inserts trace after event INSERT.
* `private.strata_v13_capture_transport()` reads intent/parent and inserts trace for selected transport observations.

These run as their actual function owner; source migrations do not fix that owner explicitly. Existing non-FORCE RLS is bypassed by the owning fixture role, not by proof that a production owner is safe. Keep the definer's privilege requirements distinct from direct runtime ACLs. Immutable audit trigger `private.strata_protective_approval_audit_immutable()` rejects trace/scope/decision UPDATE/DELETE.

Other application definers (`public.strata_claim_official_fee_capture`, `strata_can_inspect_pending_fee_artifact`, `strata_two_operator_fee_reviews_valid`, `strata_record_official_fee_provider_result`) exist in the full chain but are not shown as invoked by the API-reviewed held protective branch above. They do not justify automatic EXECUTE grants. Alternative monetary/PDF/operator-fee source branches need their own bounded dependency inventory.

### Sequences and defaults

Relevant migration-defined sequences are identity sequences, not explicit runtime `nextval` calls:

* `private.strata_v13_execution_trace_trace_id_seq` (`0044:44,124`), used inside the definer trace insert.
* `private.strata_v13_signal_decisions_decision_id_seq` (`0044:5,21`), used by conditional direct telemetry inserts.
* `private.strata_continuous_execution_audit_audit_id_seq` (`0043:85`), used by conditional technical renewal audit.

All three columns use `GENERATED ALWAYS AS IDENTITY`. Do not infer a blanket sequence USAGE grant from INSERT: identity-generation privilege semantics differ from explicit `nextval`/serial defaults. Verify the actual PostgreSQL version and trigger owner with sequence privileges deliberately absent; test explicit nextval/setval denial. No direct sequence access is evidenced in the named paths. Other fee-capture identity sequences belong to unexercised branches. UUID generation/defaults use the platform's `gen_random_uuid`; the fixture installs pgcrypto into `extensions` and grants the fixture owner schema USAGE. Actual function resolution/default dependencies need deployed-catalog verification.

### Auth and Vault boundary

`fixtures/ownerUnknownRecoveryPlatform.sql` supplies only `auth.users(id,email,email_confirmed_at)`, synthetic `auth.uid()/auth.role()` GUC readers, `vault.secrets(id)`, `financial_accounts`, `provider_connections`, and `role_assignments`. The full-supervisor fixture separately creates `vault.decrypted_secrets(id,decrypted_secret)` as an ordinary table (`heldSupervisorDispatch.postgres.fixture.ts:226-228`). This is **not** a Supabase platform export, Auth authorization proof, Vault decryption implementation, or credential isolation proof. Exact deployed ownership, grants, RLS, function signatures and default ACLs remain unknown. No actual secrets were read by this inventory.

## Pool routing and dynamic dependencies still unverified

* `kalshiAccountClient.ts:460-464` reserves signed balance quota before HTTP in production mode/global fetch. `kalshiBalanceQuota.ts:18,40-51` defaults to the global pool and upserts its member bucket; missing permissions are caught as `kalshi_read_failed` by the higher-level reader.
* `personalExecutionSupervisor.ts:445-455` calls reserve and dispatch without passing its injected `db`; reserve uses global pool (`ownerFeeEmergencyExitReserve.ts:87`), dispatch final/no-send uses global pool (`ownerFeeEmergencyExitSignedDispatch.ts:387-399`). Production forbids injected dispatcher test ports at :344, so routing cannot be changed by casually passing test dependencies in production.
* `personalExecutionSupervisor.ts:332` API-start verifier falls back to global pool (`apiFeeSourceStage.ts:113`); its standing fallback can write via global pool (`apiFeeStandingDelegation.ts:230`). Protective fee verifier defaults global (`reviewedProtectiveExitFee.ts:137,180`).
* `reconcileOwnedProtectiveExits(input, db)` uses `db` only for its reservation lookup; restart `:32-36` calls read/persist without passing that db. `ownerFeeEmergencyExitAuthenticatedRecovery.ts:100` and `ownerFeeEmergencyExitReconciliationCommit.ts:57` therefore default global. Immediate signed outcome read/persist likewise default global (`ownerFeeEmergencyExitSignedDispatch.ts:404,417`).
* `ownerFeeEmergencyExitRead.ts:32` and UNKNOWN marker `ownerFeeEmergencyExitUnknownCommit.ts:106` default global. Standalone owner-accounting recovery instead requires injected dependencies; its external material loader is caller-defined (`ownerUnknownRecoveryHeld.ts:18-26`), so the schema test's injected ephemeral material does not test real Vault loading.
* Dynamic independent-activity table names are a fixed six-element source constant, enumerated above. SQL constructor branches depend on fee policy URL, deployed SHA, standing history and feature flags; the listed legacy test seeds do not prove their other branches.
* `liveControl` legacy worker and generic ENTRY branches, actual HTTP authentication/middleware, provider connection creation, Vault writes/decryption internals, human approval submission, production pooler mode, production RLS policies/memberships/default ACLs and deployment migration history are outside this static inventory. No runtime identity changes are authorized by it.

## Suggested bounded qualification assertions, not grants

Keep privileged schema/setup/adversarial mutations on separate test-only setup connections; run every production call and hidden global checkout under a real non-owner restricted identity. Verify current/session user on each pool path. First demonstrate where SELECT-only fails. If evaluating the lock-only ACL/RLS experiment, prove row locking and competing revocation fencing while no-op and changed authority updates fail, direct approval inserts/revocations fail, and all authority bytes are unchanged. Exercise missing helper EXECUTE, missing invoker audit reads, missing auth/profile reads, audit insertion failure, missing technical-lease permissions, and real definer trigger rollback. Confirm no transport on denial, no new ENTRY, retained UNKNOWN for uncertain outcomes, and durable KILL/STOP semantics. Record unrun cases, swallowed optional telemetry errors and mocked platform gaps explicitly.

## Addendum: RLS status and lock-only experiment hazards

This is the state implied by the unchanged full source chain/platform fixture, not a live catalog observation. No FORCE RLS or runtime role policies are established by this inventory.

| Relevant relation group | Source/fixture RLS state | Evidence |
|---|---|---|
| account, event, intent, observation, position, live config, live-money policy; forward evaluations | ENABLED, no browser policies | `0000_reviewed_release_schema.sql:1854,1860-1866`; opening comment explicitly relies on backend owner bypass |
| credentials; worker lease | ENABLED | `0012_kalshi_connection_credentials.sql:102`; `0013_kalshi_account_worker_lease.sql:67` |
| financial_accounts; provider_connections; role_assignments | ENABLED in synthetic platform fixture | `ownerUnknownRecoveryPlatform.sql:24-26` |
| three API grant/review/consent tables | ENABLED | `0030_strata_api_fee_rate_source_v1.sql:60-62` |
| standing API models/delegations | ENABLED | `0034_strata_standing_api_fee_delegation.sql:46-47` |
| standing execution reviews; continuous grants/technical lease/audit | ENABLED | `0043_strata_continuous_execution_grants.sql:28,96-98` |
| protective reservations; reconciliations; local no-send; release; owner SHA approvals | ENABLED | `strata_emergency_exit_reservation_private.sql:77`; `strata_protective_exit_reconciliation_private.sql:31`; `strata_protective_exit_local_no_send.sql:57`; `strata_protective_exit_release_private.sql:47`; `strata_owner_sha_approval.sql:22` |
| manual withdrawals; auto maintenance; owner topups | ENABLED | `0025_strata_manual_profit_withdrawals.sql:26`; `0027_strata_balance_quota_auto_maintenance.sql:36`; `0032_owner_variable_topups.sql:59` |
| signal decisions; execution trace; trace scope; signal-audit progress | ENABLED | `0044_v13_signal_decision_trace.sql:19,120-121`; `0045_v13_bounded_signal_audit.sql:17` |
| `private.kalshi_owner_pilot_transfers` | **NOT ENABLED in source chain** | `0017_kalshi_owner_pilot_transfers.sql:5-44` creates table and index only; comment “No RLS policy” does not enable RLS; subsequent 0019 only adds reconciliation fields/index |
| `private.kalshi_owner_shard_allocations` | **NOT ENABLED in source chain** | `0018_kalshi_owner_shard_allocations.sql:6-53` creates table/index only; subsequent 0028 adds microdollar evidence |
| `public.strata_configured_stake` | **NOT ENABLED in source chain** | `0004_c52_entry_policy_and_configured_stake.sql:26-35`, later 0009/strict-proportional alters do not enable RLS |
| `auth.users` | **NOT ENABLED in platform stub** | `ownerUnknownRecoveryPlatform.sql:9`; actual Supabase Auth RLS/ownership unknown |
| `vault.secrets`; synthetic `vault.decrypted_secrets` | **NOT ENABLED in fixture** | `ownerUnknownRecoveryPlatform.sql:14`; `heldSupervisorDispatch.postgres.fixture.ts:226-228`; real Vault view behavior unknown |
| `public.profiles` | **ABSENT from full platform stub/application migration chain** | `0000` opening exclusion comment; `ownerUnknownRecoveryPlatform.sql` does not create it. The two minimal protective-authority tests create an RLS-disabled stub themselves. Legacy held supervisor does not execute SUCCESSOR_SQL and can pass without it. |

Consequences for the proposed lock-only UPDATE ACL experiment:

* A policy, even a restrictive policy with `WITH CHECK(false)`, does nothing until RLS is enabled. The two transfer/allocated-funds child tables are directly relevant to held locks. Explicitly adding RLS in a disposable fixture is an additional candidate design, not “unchanged production RLS.” Do not hide it as a test convenience.
* Table owners bypass non-FORCE RLS. Superuser and BYPASSRLS identities bypass it. Inherited roles or SET ROLE ability may change effective authority. Prove the actual LOGIN runtime owns none of the relevant tables and cannot assume an owner role; do not infer that from a role-name convention.
* Under enabled RLS, permissive policies combine with OR. A lone permissive UPDATE policy with `WITH CHECK(false)` does not negate an existing permissive UPDATE/ALL policy allowing a write. Use explicit catalog inspection and tests of the complete policy set; if the experiment uses AS RESTRICTIVE, prove it applies to the actual runtime role and operation.
* Auth/profile data is particularly sensitive as authority infrastructure. A narrow `UPDATE(id)` or `UPDATE(email)` ACL on an RLS-disabled table is still real mutation power, including no-op writes and potentially identifier changes. The policy experiment must not grant such ACLs under an assumption that source RLS already protects them. Legacy API-stage Auth/role checks do not require those UPDATE ACLs at all; only standing SUCCESSOR locks do.
* Source migration tables in the full fixture are owned by `unknown_recovery_backend`; the platform stub is created under the same SET ROLE. Minimal protective authority test stubs are created by the disposable bootstrap session. Neither establishes deployed Auth/Vault ownership.

The narrow locked-column candidates for human/metadata records are: policy `id`; credentials `id`; financial account `id`; provider connection `id`; live config `id`; source evaluation `id`; all six child-activity tables `execution_account_id`; fee source grant `grant_id`; rate review `review_id`; owner consent `consent_id`; standing model `model_id`; standing delegation `delegation_id`; standing review/protective release `release_id`; owner-SHA approval `approval_id`; continuous grant `grant_id`; Auth `id`; role assignments `email`; profile `id`. These are candidate capability carriers for isolated denial tests, not authority to change those values.

## Addendum: separately attributed production catalog observation

The following separately supplied bounded production-catalog observations were recorded alongside the source audit on 2026-11-09. They were not independently repeated by these tests; no catalog query artifact or precise observation timestamp is bundled here. Keep them separate from the reproducible source/fixture findings above.

| Production relation | RLS enabled | FORCE RLS | Policy count | Observed owner |
|---|---|---|---|---|
| `private.kalshi_owner_pilot_transfers` | true | false | 0 | `postgres` |
| `private.kalshi_owner_shard_allocations` | true | false | 0 | `postgres` |
| `auth.users` | true | false | 0 | `supabase_auth_admin` |
| `private.role_assignments` | true | not supplied | 0 | `postgres` |
| `public.profiles` | true | false | 2 | `postgres` |

**Correction to any broader interpretation of the static findings:** missing RLS in the checked-in source/platform fixture is not evidence that RLS is missing in current production. The separate catalog observation reports RLS enabled in production on both transfer/allocation relations and `auth.users`, and reports that production `public.profiles` exists with RLS enabled and two policies. These are concrete fixture-to-deployment differences, not current-production missing-RLS findings. The source inventory's specific fixture descriptions remain accurate.

The observed ownership still matters: a non-FORCE RLS table owner can bypass policies, and a superuser/BYPASSRLS identity can bypass RLS. A separate non-owner runtime role with zero policies would ordinarily fail closed rather than inherit usable access from table ACLs alone. The two profiles policies require their actual definitions, commands, roles and interaction to be assessed before concluding a proposed denial policy is effective; policy count alone proves neither safe access nor unsafe access. Auth's different owner must remain explicit in any definer/role analysis. No new production grants, RLS changes, ownership changes or role changes are authorized or made by this addendum.
