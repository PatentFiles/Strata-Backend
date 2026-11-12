# Validation boundaries

This is isolated work based on backend48783da92ffc979dae6df4e01638399e9d6841a3
and the earlier reviewed approval-only candidate, not a deployed revision.

The new killed path records exact-SHA code consent only. It must leave account,
worker, global, risk, credentials, financial history and independent approvals unchanged.
Consent head/binding, owner receipt and audit metadata are expected writes. Existing
released-only and enabled modes remain distinct; technical review, genuine financial
enablement and START remain separate. No automatic subsequent action is permitted.

Revocation generation is not a trading-control sequence. It binds fresh qualification
and approval requests and prevents stale consent resurrection through identified
receipt writers. It cannot make local STOP a durable global event. New no-active
approval revocation commits a tombstone/audit rather than silently rolling back.

Cutover must be verified and quiescent: every writer upgraded, migrations committed,
no old server/in-flight qualification/revocation request remains. Existing accounts
receive a migration epoch requiring fresh bindings; this is NOT an owner revocation
claim. Old zero-row revocation is inherently invisible to row triggers. Do not deploy
mixed versions or use schema errors as generation0. No deployment was attempted.

PostgreSQL tests use invented account identities, synthetic signed-feed interfaces,
real local SQL/locks/ledger conservation. Mounted UI/API tests use synthetic auth and
network. Neither establishes production readiness, actual reviewer attestation,
provider success, browser DOM execution or guaranteed live START. Browser socket
restriction is not retried or bypassed. Actual runtime database privileges and
untracked external writers remain deployment-validation prerequisites.

Independent review must check schema enforcement, all identified five revokers and
two insertions, absence/revocation/qualification races, actual two-client pending
COMMIT ordering, atomic audit rollback, lost acknowledgment and precise readback.

Release-preparation update: all four actual policy migration functions now have real PostgreSQL workflow coverage (3 fee tests plus10 repair/stake tests), with synthetic external providers and minimal relational fixtures. Read-only production catalogs and a local role-model replay establish only observed ACL/RLS compatibility, not the deployed application's database identity or a complete privilege-security audit. Quiescent coordinated cutover remains unperformed.
