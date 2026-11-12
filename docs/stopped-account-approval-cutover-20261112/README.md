# Isolated killed-account code-approval candidate

Base: PatentFiles/Strata-Backend `48783da92ffc979dae6df4e01638399e9d6841a3`. NOT deployed, pushed, or approved for production. No orders or production controls were exercised. This includes prior isolated released-only receipt changes, unchanged in semantics, and a distinct `DISABLED_KILLED_APPROVAL_ONLY` mode.

## Contract

Status exposes `disabledKilledApproval` with mode, availability/reason, exact SHA/account/policy/policy-hash/public signerFingerprint and decimal-string `consentGeneration`. Status reads never create a consent head; missing table/errors fail closed. `disabledKilledApprovalReceipt` is only present for a matching, unrevoked, current-generation killed-mode receipt. Any other active owner/account/current-SHA receipt blocks availability rather than being relabeled as this request.

Owner pins status before explicit consent. `/qualify` opt-in `approvalOnlyMode` plus `expectedSha`, `expectedAccountId`, `expectedPolicyId`, `expectedPolicyHash`, `expectedCredentialFingerprint`, and `consentGeneration` validates killed state and pin before provider reads. All qualification modes capture account/head before provider I/O and atomically persist matching generation binding with qualification after locked reread. Normal qualification remains usable after a revocation.

`/owner-authorize` with `releaseMode:DISABLED_KILLED_APPROVAL_ONLY`, the same pin, qualificationId and existing explicit owner SHA confirmation returns only through the proof/receipt branch. The original released-only mode is unchanged. Full retained-history signed proof, prior authority, qualification, identity, fee/policy, final ledger/conservation and freshness checks remain required. New mode additionally proves terminal killed/disarmed worker with valid lifecycle metadata and positive fence. It writes only owner code approval and audit (plus consent-head initialization where needed), never account/global/worker/control/financial state.

Successful result includes exact receipt identifiers and pin with `statusScope:TRANSACTION_COMMIT, readbackRequired:true`. It is not live readiness. Existing active receipt is a definitive duplicate/readback refusal, never a false success carrying a different QID.

## Generation and revoke ordering

Account-wide consent head uses bigint transported as decimal strings. Missing head means0 only for genuinely unseeded accounts. Migration seeds existing accounts at1 as a migration epoch, not invented owner consent/revocation. Pre-cutover unbound qualification cannot insert after that epoch.

All five identified revocation writers call `advanceOwnerConsent` under their existing account lock: `revokeOwnerShaRelease`, `ownerApiFeePolicyMigration`, `ownerFeeV3Migration`, `ownerV4CommissioningRepair`, `ownerStakePolicyAmendment`. Advance and immutable audit are transactional. Owner revoke with no active approval commits a generation tombstone/audit without changing account or worker controls. Lost COMMIT acknowledgment is uncertain with generation/readback metadata, not a definite failure.

INSERT trigger covers both existing owner-approval insertion modules, including legacy paths: generation>0 requires fresh matching persisted qualification binding. STANDARD bindings allow existing restoration's intentional account-row update; killed bindings require exact account xmin. A revocation UPDATE trigger requires the corresponding head to have been advanced within the same transaction, making old nonempty revocation writers fail closed. Existing-row locks serialize concurrent receipt/revoke. No-row revocation intent is represented by the explicit helper, not inferred from triggers.

## Deployment prerequisite, NOT satisfied

`consent-generation.sql` is an isolated schema candidate, not an applied migration. Requires reviewed backend-role grants/RLS and exact schema review, operator-controlled quiescent cutover with old writers drained, installation of schema and coordinated new writers, and fresh post-cutover qualification. An old server's zero-row revoke cannot be detected by a row trigger; mixed-version deployment is unsafe. Out-of-band SQL, DELETE/reset/unrevoke administration, privileged writers disabling triggers, live privileges, operational rollout and global control sequencing are not established by this patch. No automatic migration or deployment should occur.

## Verification

Local PostgreSQL16 on127.0.0.1:55453 only, disposable database. `strata-killed-approval-pg.log`:91 tests pass, including inherited proof/regression cases; new generation assertions reside within the settled-history nested test, so91 is not a count of new scenarios. Exercises successful killed receipt/readback/control immutability, old mode killed refusal, stale generation during qualification/provider reads, no-row revocation, migration epoch rejection, direct uncoordinated revocation rejection, new fresh generic enabled renewal after tombstone, real two-connection approval-first and revoke-first lock order, two different same-generation qualifications competing, no-row audit rollback, and lost COMMIT acknowledgment. Full API TypeScript check passed. Final logs must be regenerated after any review changes.

Not yet demonstrated: real deployed role/RLS privileges; PG17; operational mixed-version prevention; comprehensive external writer enumeration. Inherited gen0 regressions deliberately reset disposable head state and do not substitute for cutover tests. Source fixture includes synthetic account/auth/financial tables with actual event DDL, not a full production database clone.

Final source run: PostgreSQL16 database renewal_disposable_2026111216, 91/91 pass. Full API typecheck exit0. Public signerFingerprint survives sanitizer; expectedCredentialFingerprint remains internal request field. Parent owns route/sanitizer integration tests.

Additional epoch regressions: actual generic empty-history bootstrap rejects unbound pre-epoch QID then accepts fresh bound generic qualification; existing valid approval restoration after fresh generic qualification reuses same ID with lease unchanged. Runtime head INSERT must initialize0; UPDATE must preserve owner/account and increment exactly1. Same/lower/skipped generation and identity mutation rejected in PostgreSQL. Migration uses explicit BEGIN/COMMIT, seeds epoch1 before installing runtime initialization guard. Out-of-band DELETE and privilege controls remain outside proven scope.

## Additional release-preparation evidence

All four identified policy-revocation workflows now execute in real disposable PostgreSQL16 tests under the candidate schema: fee V3 and API fee migration (3/3 tests), V4 repair and stake amendment (10/10 tests). These exercise actual workflow functions/SQL, generation/revocation, exact refusal reasons and transactional rollback; external provider boundaries and schema fixtures remain synthetic. See FEE-MIGRATION-WORKFLOW-TESTS.md and the companion strata-killed-revoker-pg README/logs. No production policy migration was run.

Small read-only production catalog queries confirmed the queried private relations are postgres-owned, RLS enabled/non-FORCE, and only postgres has effective private schema/table privileges among postgres/service_role/anon/authenticated. A local nonsuperuser BYPASSRLS owner model successfully applied the atomic migration and executed binding/approval/revocation; the three other role models were denied. This verifies the observed privilege model, NOT the Railway runtime role. See ROLE-RLS-AND-CUTOVER.md. Runtime identity, external writer privilege exclusion, independent release approval and verified quiescent full-writer cutover remain prerequisites.
