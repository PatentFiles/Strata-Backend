# ADR: Three-layer institutional trading authority (proposed, NOT deployed)

Status: **PROPOSED — independent engineering/security/operations review required**
Date: 2026-10-20
Affected service: existing Strata-Backend; no new trading worker or replica.

## Decision

Separate durable **code release approval**, ephemeral **operational entry eligibility**, and explicit **owner runtime authority**. Preserve the existing fail-closed one-use signed protective exit and unknown-order reconciliation; the proposal does NOT itself authorize orders.

1. **Release approval** is signed independently against the exact 40-hex deployed Git SHA, reviewed diff and artifact provenance. The approval persists until **explicit revocation, deploy SHA mismatch, or a material new release**. It cannot be auto-issued from CI, DB access, a frontend field, or a service credential. Require qualified separate reviewer and owner approval. Never accept a Git branch/tag as an artifact identity. Bind exchange adapter, source, compiled artifact digest, and policy/config version in addition to SHA.
2. **Operational evidence** is short lived, automatically recomputed and account scoped: fee/effective rate model + schedule and market overrides; credential/account binding; explicit funding and cash reconciliation; exchange orders/fills/positions/settlements; no unknown/unresolved intents; loss/capital/stake limits; lease fencing token, heartbeat, kill switches; healthy protective exit capability. Evidence expiry does **not** renew or forge human code review. It blocks new inventory whenever any required component is absent/stale.
3. **Owner execution authority** is a distinct AAL2 authenticated ARM then START operation, never inferred from a review, variable, worker heartbeat, or paper signal. Persist an owner-scoped activation epoch and short revocation semantics. DISARM/STOP/KILL revoke new inventory immediately. Preserve reduce-only existing-position treatment, pending unknown responses and reconciliation.

## Critical separation: new inventory vs protective reduction

- **New entries:** need valid code approval for exactly deployed artifact, every fresh operational control, owner ARM+START, a fresh evaluation from the reviewed strategy, confirmed risk budget, and a durable idempotent order intent.
- **Protective exits:** need an independently reviewed exit-capable binary and valid signer/account fencing, nonrevoked reduce-only policy, authoritative owned position and fee/slippage evidence, and one-use transactionally fenced signed request. They must **not** be blocked solely because a new-entry operational credential/fee cache or short-lived qualification has expired. If the independent exit safety capability itself is invalid or revoked, enter emergency control/reconciliation and alert immediately—never silently permit unsupervised trading.
- Avoid using a single 2-hour review-expiry field for both entry eligibility and final signed protective-exit transport. Define and test the distinct eligibility predicates; do not remove final signed POST fencing.

## Proposed storage and invariants

Versioned **private** tables with idempotency keys, uniqueness and RLS/least-privilege grants; no mutable overwrites of historical approvals:

- `code_release_approvals`: approved artifact SHA, source/tree digest, reviewed safety policy and adapter version, reviewer identity, signer identity, approval time, revoked_at, immutable evidence digest; one active approval per exact release/policy with atomic revocation and append-only audit.
- `account_operational_evidence`: owner ID, execution account ID, observed_at, expires_at, verified canonical evidence digest, exchange reconciliation cursor, policy/fee version, lease token and decision details. Never store vault secrets.
- `account_execution_authorizations`: owner ID, account ID, approval SHA, desired ARM and START state, control epoch, AAL2 timestamp, revoked_at, reason and audit references.

Use DB transactions and row locks/fencing for state transitions and final submit, and compare time using **database server time**. Prevent TOCTOU by rechecking operational authority inside the final signed-order transaction. A one-use request stays spent after any uncertain network outcome; reconcile exchange history rather than retry.

## Explicit transition rules

- BUILD -> TEST -> INDEPENDENT CODE REVIEW -> SIGNED APPROVAL -> DEPLOY MATCHING SHA.
- DEPLOY or policy/reviewer revocation => new-entry closed until independently reapproved.
- Evidence poll success => eligibility may become READY only if code approval and owner authority remain valid.
- Evidence poll failure/staleness/unknown -> NO_NEW_ENTRIES immediately; protective position lifecycle remains available under its dedicated safety proof.
- ARM requires fresh operational evidence and approved code; START requires ARM, new full reconciliation and a fresh fenced worker claim. A restart after a crash is **not** implicit reauthorization.
- KILL overrides any affirmative stale cache and increments the authorization epoch; queue workers may only reduce/reconcile if an independently approved protective path still exists.

## Test plan — must pass before adoption

- SHA mismatch, artifact mismatch, reviewer self-approval, expired AAL2, forged grants or duplicate approvals all deny.
- TTL boundary and clock-skew tests: operational evidence expires exactly at its maximum age; fee changes invalidate cached evidence promptly.
- Multiple owned accounts sharing numeric Kalshi subaccount/index never cross-select.
- Crash between reserve/POST/ack, delayed/partial IOC fills, HTTP timeout, unknown result, two workers racing a fencing token, stale heartbeat, and retry attempts never duplicate orders.
- Code approval remains durable across repeated healthy data polls; short-lived evidence never becomes human approval.
- Expiring *entry* evidence suppresses new entries while existing inventory's independently reviewed reduce-only exit continues safely when valid.
- Revocation or kill during in-flight order leads to fenced unknown state and full authoritative reconciliation, not an optimistic terminal status.
- Paper signal generation does not authorize live orders.
- Production validation remains staged and limited: isolated tests -> read-only live exchange reconciliation -> independently reviewed protected execution qualification -> approved owner activation; no forced funded trade.

## Migration and rollout constraints

1. Ship additive schema and dual-read diagnostics before switching authority semantics. Supabase public tables created after the October 30 grant change need explicit grants where intended; prefer private authorization tables with no anon access.
2. Audit existing approvals and preserve their immutable historical meaning; do not reclassify old short-duration evidence as permanent human review.
3. Deploy an off-by-default shadow evaluator that compares old and proposed decisions read-only, including restart/crash scenarios, without changing trading authority.
4. Obtain genuine independent review for the full policy code and explicit operator/owner cutover. Select one verified release SHA and document rollback.
5. Switch only during a controlled no-exposure maintenance window after complete exchange reconciliation. On any mismatch revert to prior fail-closed behavior, not to unrestricted trading.
6. Never merge this proposal as an active authorization change without full regression, security review and approval. A written ADR is not executable approval.

## Status / dependencies

- Recovery code for owner-account freeze and signal producer is in draft backend PR #113; frontend owner consent in PR #80.
- Railway deployment with configured producer flag is still pending.
- Existing approved protective-exit release for the previously deployed SHA is expired. The *current* two-hour release and 20-minute buffer must remain enforced until independently approved redesigned controls are deployed.
- Only an independently reviewed and implemented proof can resolve the outstanding exit-on-expiry question. No claim of live-money readiness should be made before that evidence exists.
