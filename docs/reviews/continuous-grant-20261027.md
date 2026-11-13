# Standing execution engineering audit

This candidate extends PR #245 (which already includes PR #240), with backend PR #246 and frontend PR #173. It is not a production release or an independent human attestation.

## Implemented

- Separate, explicit, immutable standing technical review scoped to deployed SHA, owner, execution account and policy hash. No expiry or automatic conversion of old finite reviews. The authenticated reviewer must be distinct from the owner and have a current operator role when recording the review; the request includes the exact displayed scope, a fresh qualification, review PR and substantive findings.
- Separate authenticated owner enrollment and one-way revocation. Revoked grant history cannot fall back to legacy authority. Code, account or policy drift denies entry. Replacing a reviewed scope requires explicit new consent.
- START bootstrap is distinct from entry eligibility. Five-minute technical leases renew from successfully committed signed reconciliation, with current worker generation, heartbeat, cash, policy and unresolved-exit checks. No owner or reviewer signature is extended.
- Final entry and fee-transport fences consume the standing scope; final protective exits consume the separate standing technical review. Owner entry revocation preserves the separately reviewed reduce-only protection. Technical-review revocation invalidates that code authorization. Existing one-use UNKNOWN, quantity, fees, account and risk checks remain enforced.
- Reviewed API and monetary fee transports borrow the executor's transaction instead of opening a second connection that can block on the executor's own account lock. Borrowers cannot BEGIN, COMMIT or release the owning transaction.
- Awaited decision writes, correct text/UUID validation, idempotent phase retry and actual per-phase signal age. Transactional database triggers capture intent transitions, transport observations and reconciled exchange events in an immutable private trace ledger. Financial state and its trace commit or roll back together. Trace rows never authorize resubmission.
- Durable audit horizon initialized at migration/account creation. Oldest-first bounded sweeps catch signals missed during downtime beyond fifteen minutes without guessing a historical rejection reason.
- Owner enrollment/revocation and independent review controls, automatic read-only status refresh, stale-status expiry and standing-aware commissioning display. No automatic trading, funding, credentials or worker-control action.

## Verification and limits

Real isolated PostgreSQL tests exercise both migrations, explicit scope checks, bootstrap without a lease, signed lease renewal, concurrent entry-grant and technical-review revocation, durable crash traces, atomic trace failure, private-table access denial and delayed bounded catch-up. Embedded PostgreSQL tests cover drift, worker restart, STOP, cash mismatch, unresolved exits and immutable scope. The complete existing safety/recovery suite and frontend typecheck/lint/build/regressions run in CI on the final commit; inspect the current PR checks rather than treating an earlier SHA's result as current.

The first real PostgreSQL latency run measured 40 local authorization queries: p95 10.08 ms, maximum 10.51 ms, below the 250 ms local budget. This does NOT measure production exchange/network latency. The five-second signal freshness gate is unchanged. Paper triggers cannot guarantee an exchange fill; stale prices, depth, fees, budget, revoked authority or unavailable evidence must still reject entries. Phase timestamps support subsequent production timing analysis.

The existing separately signed fee-model/delegation authority remains bounded (currently 30 days), SHA-bound, revocable, and subject to fresh official market evidence. This patch does not silently extend that financial approval. New deployed SHA requires its applicable fee review/consent through the existing workflow. Ordinary short technical lease renewals do not create human reviews, but an expiring fee-model authorization remains an explicit renewal boundary. Do not describe the complete platform as indefinitely approved solely because the execution grant has no expiry.

## Production observations and cutover

Railway access resolved using the supplied existing project ID. The observed successful deployment was main SHA 81a496d110ede1db8aeff0be36bfb9255a2280e5, not this candidate. Read-only HTTP logs showed the existing application serving requests; this is not live-entry qualification. No production migrations, approvals, worker state or orders were changed by this audit.

Before release: review the final integrated source and migrations; verify fresh signed exchange evidence of flat positions, no open orders or unresolved attempts; release the current worker lease through supported controls; perform one controlled deployment with entries held. Validate the actual deployed SHA, schema, trace persistence, fees and health. Record independent standing review and owner consent through authenticated UI for that exact deployment. Then owner ARM preflight and separately confirmed START may be used. Never substitute database balances or test fixtures for signed exchange-flat evidence.

Rollback must preserve immutable audit and financial records. Do not rotate or roll back a running, exposed worker. An older binary is not authorized merely because it previously ran. Exchange failures and revoked authority must hold new entries; uncertain POSTs remain recovery-only, never blindly replayed.
