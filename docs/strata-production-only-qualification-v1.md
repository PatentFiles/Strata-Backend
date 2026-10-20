# Strata production-only qualification protocol v1 — candidate for independent review

**Status:** proposed controlled release procedure. **NO DEMO**. No auto-activation, order authority, human signature, or exchange execution evidence is conferred by this file.

## Scope and baseline
Only KXBTC15M, authenticated owner-scoped Subaccount 1 / Exchange Index 2, the current approved V13/C52-C53 strategy and existing trusted worker, encrypted signing keys never exposed to clients. Preserve all historical financial events. Never initialize a new Railway project or modify the live strategy.

The owner has expressly directed a release qualification route without a Kalshi DEMO account or DEMO credentials. Do not run DEMO workflows and do not insert simulated records into provider-evidence tables. The absence of a DEMO run is not, by itself, proof of production execution.

## Phase A — no-order production qualification (safe while live OFF)
1. Attest the running backend SHA, protected production Railway environment, migrations, account/lease/credential fingerprints, default-off signed dispatcher, global/account kill states and currently signed approval records. Use read-only queries. Redact identifiers and never output credentials.
2. Using an authorized owner session and server-side vault signer, make **GET only** requests to the PRODUCTION Kalshi account for scoped balance, open/historical orders, fills, full-position history, and settlements. Verify complete cursors, explicit account scope, consistency and timestamps. Missing/ambiguous data fails closed.
3. Independently obtain fixed-origin public production exact-market/series/event fee type, multiplier, relevant change schedules and price grid. Evaluate the immutable conservative decimal reference vectors and read the persisted approved owner-specific fee policy and source grants. Never claim provider-backed monetary coefficient or fee receipt unless independently verified.
4. Run all full V13 tests, private-schema immutability tests and unit/provider-shape regressions on the exact reviewed commit, plus an isolated crash/restart rehearsal covering 0, partial, full, timeout, lost POST response, duplicate worker and account/global kill races. These are **offline evidence only**; label them as such.
5. Obtain independent exact-commit security review and explicit owner/operator acceptance of the **production-only** risk model and loss budget. A reviewer must inspect any remaining gaps before approval. No assistant or automation impersonates a reviewer or forges acceptance.

## Phase B — tightly gated first REAL order; distinct authorization
Actual provider order/fill execution cannot be proved with only GET calls and offline mocks. Do not require DEMO to obtain it; instead allow **only after Phase A approval** a one-time, individually authorized PRODUCTION canary. It is not blanket START authorization. The operator must approve a small position risk cap **not exceeding the existing lower of configured stake, approved account/policy limit and verified spendable cash**, a single active market/account pair, one order identity, bounded expected fees/slippage, an exchange reconciliation timeout and a tested manual kill/recovery process. Default deny if any element is unproven.

The canary uses the same production exchange/executor controls as final release, with separate temporary scope and expiration, a durable immutable pre-POST intent marker and never retries after UNKNOWN. If a fill creates a position, an independently checked reduce-only IOC exit or authenticated settlement evidence is mandatory; do not treat cancellation as a protective exit. All order IDs, signed provider receipt details, cumulative fill counts, position movement, fees, realized P&L and balances must be reconciled to the authoritative V13 ledger without creating fictitious evidence. Partial/zero/full outcomes not observed live must remain labeled as offline-tested, not provider-proven.

The canary MUST NOT be triggered as a side effect of writing this protocol, merging a PR, changing Railway variables, or applying a migration. It requires a distinct operator authorization of the real-money amount and account after review.

## Phase C — final activation
Only after accepted Phase B evidence and version-bound independent release approval, confirm fee grants/owner consent, checked cash and policy, immutable exit floor >= 0.01 USD, protective recovery and no unresolved intent, real deployed SHA and server health. Issue distinct authenticated account/global releases through the existing backend. Step 12 ARM is readiness only and MUST NOT schedule a worker or transmit an order. Step 13 START may schedule only after all gates pass; a failed check leaves kill switches and live exposure protection intact. Do not auto-toggle global live flags as a result of passing CI.

## Known P0 implementation gap that must be closed before Phase B
`monetaryFeeContract.ts` still requires a fresh PDF from `establishOfficialFeeDigest()`; `guardedReviewedApiFeeWire.ts` and the signed protective dispatcher call `verifyMonetaryFeeContract("ORDER_ENTRY")` even for the reviewed PDF-free API source. Official PDF HTTP 429 therefore blocks all signed final orders, including reduce-only exits, despite an otherwise valid API-first fee grant. The release reviewer must require an **approved versioned provider fee-model alternative** with independent rate verification, exact market/series/event/override checks and conservative fee bounds. Do not simply skip fee proof or call a public API multiplier a verified monetary fee schedule.

## Evidence and acceptance rubric
Record verified source, timestamp, account scope, backend SHA, reviewer GitHub identity, audited operator authorization, test type (read-only/offline/canary-live), failing/unknown states, event and order digests, actual signed provider receipts and account/ledger reconciliation results. Explicitly distinguish observed LIVE provider outcomes from simulated fixtures. Acceptance is signed only by the authorized humans after reviewing the collected evidence; no code path silently self-approves.
