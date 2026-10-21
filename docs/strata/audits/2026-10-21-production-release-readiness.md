# Strata KXBTC15M — production release evidence audit

**As-of:** 2026-10-21 09:35:40 UTC (database read-only snapshot).
**Result:** **NO-GO for new live orders.** This document records observed state only; it does not grant release authority, change controls, or represent a verified Railway deployment.
**Scope:** Personal KXBTC15M C52/C53 account and shared production safety; no unrelated strategies.

## Source control and CI

- Backend `main`: `cc82c4fa2ec963e540c1500a28eb71b2c87a53b1` (PR #124 fee-bridge transport-fencing hardening, merged). Its earlier exact head `dad143089d6c1b4f3621aefbab4550ada2f2bab7` passed both required PR workflows. Post-merge runs for backend main passed: [V13 diagnostics](https://github.com/PatentFiles/Strata-Backend/actions/runs/39577751692), [operator fee/final-order safety](https://github.com/PatentFiles/Strata-Backend/actions/runs/39577751768), [signed read-only proof](https://github.com/PatentFiles/Strata-Backend/actions/runs/39577751752).
- PR #123 canonical fee-source fallback merged at `66b40c2e41a3a1524bbde8f1bf2a04f476bbdd9e`; PR #124 restricts alternate official PDF egress to the captured production fetch transport, with a negative injection regression and dedicated CI trigger.
- PR #113 consolidated the code from predecessor drafts #110–#112; those draft PRs were closed as superseded to prevent double merge.
- Backend issue #29 was closed as a *code-level* fix: personal worker obtains event/series fee and scheduled change evidence, `ownedMarketEvidence` requires `verifyOwnedFeeMetadata`, and `v13-production/executor.ts` re-reads and compares fee fingerprints at the locked final submission fence. This is not proof of present exchange access.
- Frontend `Meta-UO/TradingApp` main at `27ebe3106f49c5ed3b933276e0a53a548913ec6e`: [pre-live CI passed](https://github.com/Meta-UO/TradingApp/actions/runs/39571686190). No Bolt publication attestation was observed.
- The connected Railway account returned **zero accessible projects**. An exact production deployed backend SHA, worker/container health and runtime endpoint response could **not** be independently verified. GitHub CI success != Railway deployment.

## Production Supabase state (read-only; no actor IDs, credentials or balances exported)

Project `wqsmfbzfbiilhtzpqbrb` was ACTIVE_HEALTHY. The following aggregates were queried directly from the production PostgreSQL backend:

| Check | Result |
| --- | --- |
| Live configuration | `mode=V13_PRODUCTION`, `live_execution_enabled=true`, `manual_kill_switch=false` |
| Production accounts | 6 total; 4 commissioned; 1 execution-enabled with account kill off |
| Commissioned accounts with provisional freeze | 3 retain `blocked_reason='awaiting_account_commissioning'` |
| Execution-enabled but frozen accounts | 1 (must not treat 'enabled' as ability to place orders) |
| Account worker lease | 1 stale owned lease, last heartbeat 2026-10-20 21:00:28.479 UTC; none heartbeating in last 30s |
| V13 database order intents / position rows | 0 / 0 (does **not** establish zero authoritative exchange exposure) |
| Canonical official fee captures | 0, none current |
| Unrevoked owner SHA approvals | 0 |
| Active protective-exit release rows | 0 |

The existing Supabase fixed-origin fee capture Edge Function was deployed and active, but the canonical-origin capture table had **no successful provider PDF record**. A container-local diagnostic could not resolve `kalshi.com`; this is a local DNS limitation, not evidence of Kalshi's current HTTP response. Production provider status remains unverified in this audit.

**Critical distinction:** global live flags appear enabled although no current release evidence was found. Do not infer a running order sender from these fields; do not infer safety from empty local intent/position tables. Do not clear or rewrite `blocked_reason` by hand, renew approvals, reset the stale lease, or toggle kills to force release. Qualified owner-scoped exchange reconciliation, zero unresolved exposure, reviewed deployment identity and an audited atomic remediation are required.

## Remaining acceptance gates (authoritative issue tracking)

1. [#52](https://github.com/PatentFiles/Strata-Backend/issues/52) — genuine current official fee-document capture. Restore provider-approved source access; pin TLS canonical origin, byte hash, PDF parser, capture time, correct series/event/market fees and fee schedule exceptions. An expired fixture, cache or local upload cannot be represented as current provider evidence. Existing failure must remain fail closed.
2. [#20](https://github.com/PatentFiles/Strata-Backend/issues/20) — independent document provenance and private immutable artifact review. Prove exact object bytes, signed reviewer/owner provenance, expiry and revocation across Step 9 and commissioning, including negative cases. A private storage object is not provider attestation.
3. [#77](https://github.com/PatentFiles/Strata-Backend/issues/77) — separately versioned official Trade API fee source. Code for candidate/review/revocation and per-order fences exists, but production acceptance requires a genuinely authoritative full fee formula/rate schedule and independent authenticated review/owner consent. API metadata alone is not the publisher's full fee schedule; do not silently reclassify existing PDF approvals.
4. [#46](https://github.com/PatentFiles/Strata-Backend/issues/46) — executable signed protective-exit and crash recovery. Existing code/CI exercise idempotency and negative paths; independently review the exact SHA, prove supported reduce-only IOC behavior under controlled exchange conditions, partial/zero/full fills, timeout/UNKNOWN, restart and reconciliation, and prevent position flip. Do not substitute a dry-run for a signed operational proof.
5. [#58](https://github.com/PatentFiles/Strata-Backend/issues/58) — final live-release evidence: (a) reconciled correct execution account + cleared historical sentinel through authenticated audited workflow, (b) verified current fees and exact policy/stake, (c) exact Railway deployed SHA + health + producer, (d) frontend publication identity, (e) genuine reviewed account-specific authorizations and protective-exit validation, (f) separate explicit owner ARM/START after risk and kill controls pass.

The old Step 9 HTTP 429 issue #21 was closed as a duplicate of #52; no blocker was declared resolved by this bookkeeping. Staged institutional code-approval draft PR #115 must NOT be bulk-merged into the owner-release implementation until its security semantics, migration, rollback and version-bound tests are reviewed against current main. Other overlapping older draft branches should not be bulk-merged.

## Controlled rollout and rollback criteria

**Pre-merge:** exact PR HEAD pass on relevant CI suites; no unexpected changes to credentials, markets, order signatures, balances, policy/limits, kill switches, or release state. Secure independent review for execution/fee-policy changes.

**Pre-deploy:** available Railway project access; a snapshot of current code and deployment; coordinate current worker STOP and authoritative exchange reconciliation. Verify the service target matches the repository and service environment, then deploy only explicitly reviewed release SHA with a rollback route. Never infer deployment from a GitHub merge.

**Post-deploy read-only:** `/healthz`, `/api/strata/release`, current deployed SHA, source fee preflight reason, owner identity, full cursor orders/fills/positions/settlements and cash matching the ledger, unexpired protective exit and code approval, same frontend source. Preserve audit artifacts with sanitized logs. Do not claim READY if any check is missing.

**Live action:** owner alone must separately authorize their own account (no fabricated human attestation); shared infrastructure safeguards remain independent. Only then individually ARM and START. No automatic live order, fund movement or kill override from this audit.

## Verification boundaries

This report did not fetch credentials, read wallet keys, run signed production order POSTs, certify a Railway deployment, alter SQL rows, forge reviews, move funds or claim profitable live strategy results. Exact post-deployment readiness is **UNVERIFIED**.
