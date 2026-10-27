# Continuous execution candidate review — 2026-10-27

Reviewed candidate: PR #245 at d639c42bc684cb73638f8f2a112f201fd7a49134, which already includes PR #240 polling cadence. This follow-up is an engineering hardening patch, not independent production authorization. No production records, worker state, orders, releases or deployment were changed.

## Corrections

- Bootstrap and entry eligibility now require the referenced technical review to remain approved and unrevoked. Technical renewal checks the same review and the owner's SHA approval.
- Technical leases bind to the current worker fencing token. A new worker generation cannot reuse an earlier worker's lease, even when it has time remaining.
- Entry eligibility checks current worker ownership, heartbeat, STOP and account-kill state.
- Grant scope cannot be updated or deleted; revocation is one-way and requires a reason. Signal decision records are immutable and ages cannot be negative.
- Future-dated exchange evidence and zero fencing tokens are rejected.
- Existing finite exit-release expiry remains enforced with the existing 20-minute entry margin. This is deliberately NOT the requested indefinite operation: the protective-exit final sender still rejects an expired release, so letting entry renewal outlive that release is unsafe.

## Verification

- Workspace typecheck: passed.
- Grant SQL migration and authorization/worker tests: 22 passed, no skips; includes embedded PostgreSQL execution, not just SQL string matching.
- Existing protective-exit/restart/failure tests: 111 passed, no skips.
- Readiness tests: 6 passed.
- Full safety command attempted locally: blocked at tsx IPC socket creation (EPERM). Readiness tests were rerun successfully using node --import tsx. This host also lacks native PostgreSQL binaries required by the full disposable-cluster runner.
- Added CI workflow for the focused checks and existing full safety suite in a new isolated local PostgreSQL cluster. CI results must be inspected separately; this document does not assert they passed.

## Still required before production

1. An explicit independent review scope for standing execution and protective exits, consumed consistently by START, renewal, final entry send, and final protective-exit send. Do not silently reinterpret a finite review as indefinite authority or extend/re-sign an existing review.
2. Revocation must dominate all fallback paths. The candidate supervisor currently uses `activeRelease.ok || standingEligible`; grant revocation can therefore fall back to a still-valid finite release. Fix and test this at the final send boundary, including concurrent revocation.
3. Renew only after actual account reconciliation. The candidate invokes renewal in `readSnapshot`, before the executor finishes reconciliation, and hard-codes `unexplainedCashActivity:false`. Complete history retrieval is not equivalent to reconciled cash/fills/positions. Add outage, 429/5xx, partial fill, UNKNOWN, recovery, duplicate-contender and final-fence races to the combined acceptance suite.
4. Replace best-effort `void` signal writes with durable transactional tracing/outbox semantics. The existing in-memory seen cache suppresses retries even if persistence fails, and the unseen sweep is skipped when entries are held. Link signal, intent, attempt, exchange response and actual fill without treating paper marks as realizable profit. Benchmark tracing and provider load against the five-second gate.
5. Complete owner UI enrollment/revocation and verify fee-delegation lifecycle; current fee limits must not be assumed indefinite.
6. Run the entire combined suite, independent review and signed flat/no-outstanding-order verification, then one controlled release. No merge/deploy while a worker owns the current lease.

## Access observation

The connected Railway `list_projects` operation returned an empty project list during this review. Current deployment SHA and flat-account state were not verified. Restore access to the existing deployment before considering cutover; do not create a replacement project or claim the historical SHA is current.
