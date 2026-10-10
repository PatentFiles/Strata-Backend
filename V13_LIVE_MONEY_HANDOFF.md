# V13 Live-Money Handoff

## Handoff status

**State: IMPLEMENTED SOURCE FOR INDEPENDENT REVIEW / NOT LIVE-ENABLED**

This branch supplies the separate production consumer, executor, adapter and durable ledger for Brit's independent review. It does not authorize trading. A later, independently approved production policy may authorize up to a **$5,000 contract-notional entry** only after independent review, deployment controls and live commissioning described below are completed.

Start with **[V13_BRIT_ACCEPTANCE.md](V13_BRIT_ACCEPTANCE.md)** for last actual read-only verifier evidence and final-revision requirements, and **[V13_PRODUCTION_ACCEPTANCE.md](V13_PRODUCTION_ACCEPTANCE.md)** for source and isolated PostgreSQL acceptance. Brit independently reviews the implemented paths; unfinished engineering is not delegated to that review. Runtime commissioning remains **BLOCKED**.

The handoff branch is `chatgpt/diagnose-v13`. It is expected to remain synchronized with `main` before merge. The GitHub Actions workflow attached to the current PR head is an acceptance gate: **do not accept or merge the handoff unless that run is green**.

This branch does **not** enable production trading, approve a risk policy, change credentials, fund an account, submit/cancel an order, deploy, or merge itself into `main`.

## Design rule

> The V1.3 signal decides whether an opportunity exists. The execution/risk layer decides whether and how much of that opportunity is executable.

The $5,000 value is an authority ceiling, not a target stake. The executor must size down or refuse the trade when liquidity, fees, capital, loss limits, quote freshness, policy state, or reconciliation state require it.

## Strategy behavior preserved

The designated first-live strategy authority is **V1.3 C52/53**.

- SCOUT: initial qualifying V1.3 entry, $8-$15 separation, maximum strategy price 52c.
- CONFIRM: alternative initial qualifying entry, $20+ separation, maximum strategy price 53c.
- One live position/action sequence per market.
- Position-sourced CONFIRM does not create a second buy.
- Wrong-side recross and momentum-invalidated exits remain strategy exit triggers.
- UP maps to YES; DOWN maps to NO.
- Entry-price ceilings were deliberately promoted from the original 60c/68c baseline to C52/53 after the 267-trade bounded optimization and holdout/stress review. Exit logic was not retuned.

### Strategy parameter architecture

The executable V1.3 classifier is bound to immutable launch champion `v13-champion-2-c52-confirm53` and SHA-256 parameter hash `314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161`. Alternative thresholds live in separate research-only DRAFT/SHADOW/RETIRED parameter sets with database-enforced `execution_authority = false`.

The forward-test worker records active challenger opportunity classifications only after the champion cycle commits and behind a separate error boundary. Micro-live and production preflight both require the exact champion parameter-set ID/hash.

See `V13_STRATEGY_RESEARCH.md` for the adaptive champion/challenger architecture and `V13_THRESHOLD_OPTIMIZATION_267.md` for the 267-trade optimization study and ranked shortlist.
See `V13_LOSS_FORENSICS_267.md` for the reconstructed C52/53 losses, the hit-rate tradeoff, and the forward-test telemetry required for the next optimization cycle.
See `V13_OPPORTUNITY_REPLAY_AND_SIZING.md` for counterfactual rejected-opportunity replay and the research-only confidence-weighted sizing challenger.

## Correctness and execution fixes already applied

1. Paper discretionary exits use the held side's executable bid rather than midpoint.
2. Missing executable bids do not fabricate a paper exit.
3. Expiry without an explicit Kalshi result does not infer settlement from Coinbase BTC.
4. Paper sizing uses whole contracts.
5. Initial CONFIRM may be the single entry.
6. Live entries are IOC rather than GTC; unfilled remainder cannot silently rest after the signal edge moves.
7. Valid IOC partial/zero-fill responses are normalized without weakening uncertain-response reconciliation.
8. The orderbook reader retrieves a bounded 100-level ladder.
9. Entry sizing walks visible ask depth only up to the persisted V1.3 reference offer and the C52/53 strategy cap.
10. Entry fee/risk reservation may size the order downward after depth planning.
11. Large exits use reduce-only IOC bid-depth planning with an explicit floor and explicit residual quantity.
12. Clean-build and disposable-database CI plumbing are in place without weakening production database guards.
13. The read-only `scripts/verify-live-readiness.ts` verifier performs PostgreSQL SELECT and signed Kalshi GET operations only and refuses non-SELECT SQL. It independently reports the database destination, explicitly checks all 17 commissioning linkage fields, enforces both global safety gates, and exits 2 on blocked/incomplete readiness. Its source and focused tests are now included in workspace typecheck/CI. Prerequisite failures still prevent Kalshi requests; it never grants execution authority.
14. Every forward-test evaluation now persists bid/ask spread and BTC/Kalshi snapshot ages; every new paper position persists the exact champion ID/hash plus selected-side entry bid/spread, quote ages, and seconds remaining so wins, losses, and rejected opportunities can be diagnosed prospectively.

## Production-scale components already provided

### `v13ExecutionPlanner.ts`

- Full-depth IOC entry planning.
- Hard $5,000 notional boundary tests.
- Never chases above the persisted V1.3 signal/reference price.
- Sizes down when visible book depth cannot absorb the requested stake.
- Reduce-only exit planning with explicit residual reporting.

### `v13LiveMoneyPolicy.ts`

- Versioned DRAFT / APPROVED / REVOKED policy rows.
- Pinned champion strategy parameter-set ID/hash; a strategy promotion invalidates the old policy identity until deliberately re-approved.
- Maximum entry stake capped at 500,000 cents ($5,000).
- Separate fee-inclusive all-in entry ceiling.
- One-position maximum.
- Daily and total loss limits.
- Quote and fee-evidence freshness limits.
- Full-depth and IOC requirements.
- Pinned fee-policy/source/formula identity.
- Immutable deterministic policy-hash requirement when APPROVED.

### `v13LiveMoneyRisk.ts`

- Verifies APPROVED state and policy hash.
- Applies contract-notional and all-in ceilings.
- Checks cash and remaining authorized capital.
- Checks daily and total loss state.
- Checks quote age and fee-evidence age.
- Checks fee-policy/source/formula identity.
- Fails closed.

### `v13LiveMoneyEntryPreflight.ts`

- Combines exact depth plan, fee evidence, cash state, loss state, and approved policy.
- Fee evidence must match the exact planned contract count and IOC limit.
- Returns the exact plan, policy hash, and fee fingerprint that a one-use POST capability must bind to.
- Never submits an exchange order itself.

## Critical boundary: micro-live is not the production executor

**Do not raise the existing micro-live $1/$5/$25 commissioning constants to $5,000.**

The commissioning harness intentionally contains small-dollar run caps and exact $25 dedicated-pair funding provenance. Some micro-unit fields were designed around those limits. Production-scale money and fee ledgers must be separate and use storage types that safely cover production values.

The production executor may reuse proven strategy, planning, account-read, reconciliation, and safety concepts. It must not convert the commissioning harness into a $5,000 executor by changing constants.

## Production implementation and independent-review contract

### Entry path

For every production entry:

1. Receive a persisted qualifying V1.3 SCOUT or initial CONFIRM evaluation whose strategy parameter-set ID/hash exactly match the approved champion release.
2. Read a fresh full-depth Kalshi book.
3. Call the shared IOC depth planner using the persisted V1.3 reference offer.
4. Fetch and verify current fee evidence for the exact market.
5. Calculate entry-fee and reserved-exit-fee bounds for the exact plan.
6. Load exactly one APPROVED production policy and verify its deterministic hash.
7. Load authenticated account cash, authorized capital remaining, open-position count, daily loss, total loss, and unresolved-order state.
8. Run `preflightV13LiveMoneyEntry`.
9. If preflight fails, do not mint mutation authority and do not POST.
10. If preflight succeeds, atomically reserve the exact all-in amount.
11. Mint a single-use POST capability bound to:
    - market;
    - direction/side;
    - contract count;
    - IOC limit price;
    - policy ID/version/hash;
    - champion strategy parameter-set ID/hash;
    - fee-evidence fingerprint;
    - source V1.3 evaluation/crossing;
    - reservation ID.
12. Immediately before POST, re-read/revalidate all final barriers.
13. Submit exactly one IOC entry.
14. Reconcile fills from authenticated exchange GET evidence. Never infer a fill from the request or from an ambiguous response.
15. Release only amounts proven unnecessary by terminal exchange evidence. Unknown outcomes remain reserved until reconciled.

### Exit path

For every exit:

1. Reconstruct owned contracts from authenticated fills/settlements.
2. Build a reduce-only IOC exit from visible bid depth.
3. Apply an explicit minimum acceptable exit price.
4. Never assume the full position can exit at best bid.
5. Persist and reconcile residual quantity after the IOC result.
6. Continue controlled exit/settlement handling until ownership is conclusively resolved.
7. Settlement requires authoritative Kalshi result/evidence.

## Required production ledger evidence

Every attempted production trade must persist enough evidence to reproduce the decision and capital state:

- V1.3 evaluation ID and crossing key.
- Champion strategy parameter-set ID/hash.
- BTC signal price, target, buffer, velocity, and timestamps.
- Complete normalized decision-time bid/ask ladder used for sizing.
- Quote observation timestamp and age.
- Planned contracts, worst IOC limit, and expected VWAP.
- Policy ID/version/hash, including its pinned champion strategy parameter identity.
- Fee-policy identity and fee-evidence fingerprint.
- Reserved entry fee, reserved exit fee, and total all-in reservation.
- Reservation ID and mutation-capability identity.
- Client order ID and exchange order ID.
- All fills including fee values.
- Partial/canceled/rejected/unknown states.
- Reconciliation attempts and evidence.
- Exit ladder/limit and residual quantity.
- Final settlement and reconciled net P&L.

## Final champion-selection gate

C52/53 is the **designated launch champion** and Brit should build the production executor around its parameter-version identity.

Immediately before first live-money approval, the operator must perform and persist a final champion-selection review. The production policy cannot become APPROVED unless it contains:

- the selected champion parameter-set ID/hash;
- a non-empty champion-selection review ID;
- a SHA-256 evidence hash for the review package;
- the operator identity that selected the champion;
- the champion-selection timestamp, which must precede policy approval.

The review must consider all prospective evidence available at that time. A stricter challenger may replace C52/53 only through a reviewed champion release and full policy re-approval. Broader historical references such as legacy 60/68 or C57/56 require independent outcome evidence before they can displace C52/53.

If no challenger has a clearly stronger production case, **C52/53 remains the first-live champion**.

## Mandatory acceptance gates before any production live-money enablement

All of the following must be true:

- [ ] Current PR head is synchronized with `main`.
- [ ] Current GitHub Actions diagnostics run is green.
- [ ] Workspace typecheck and full build are green.
- [ ] Paper V1.3 parity/regression tests are green.
- [ ] API and forward-test integration tests are green.
- [ ] Kalshi account/trading-client tests are green.
- [ ] V13 $5,000 depth-planner tests are green.
- [ ] V13 production risk tests are green.
- [ ] V13 production preflight tests, including champion parameter-identity rejection tests, are green.
- [ ] V13 research/challenger isolation tests are green.
- [ ] Full micro-live safety suite remains green.
- [ ] Index-2 provisioning-route tests are green.
- [ ] Production executor and separate production ledger are implemented and reviewed.
- [ ] Production money fields are wide enough for all notional/fee/reservation values.
- [ ] One-use mutation capability is implemented and cryptographically/logically bound to the exact preflight.
- [ ] Reservation and uncertain-response recovery are atomic and fail closed.
- [ ] Read-only live-readiness verifier returns no blocking mismatch/incomplete state in the intended deployment environment.
- [ ] Final champion-selection review is completed and evidence-hashed.
- [ ] Approved policy is pinned to the selected champion ID/hash and includes champion-selection review ID, evidence hash, selector identity and selection timestamp.
- [ ] One production policy is intentionally approved with explicit operator identity and immutable hash.
- [ ] Live credentials/account identity are independently verified.
- [ ] Initial live commissioning is performed at controlled size rather than immediately forcing the $5,000 ceiling.
- [ ] Fill rate, VWAP/slippage, fees, residual exits, reconciliation accuracy, and realized net expectancy are measured before size promotion.

## First-live commissioning rule

The production architecture may permit a $5,000 ceiling, but the first live deployment should prove the exact production path at controlled size. Promotion should depend on measured execution quality and reconciliation integrity, not elapsed time or trade count alone.

Do not treat the original 267-paper-trade displayed P&L as production P&L. The signal sample remains useful, but earlier paper accounting was optimistic before executable-bid exits and authoritative settlement were enforced.

## CI coverage

`.github/workflows/chatgpt-v13-diagnostics.yml` is the handoff validation workflow. Its production/micro-live safety step invokes `test:v13-safety-all`. The legacy `test:micro-live-all` name remains only as a compatibility alias to the same umbrella suite. The V13 suite includes:

- `test:v13-execution-planner`;
- `test:v13-live-money-risk`;
- `test:v13-live-money-preflight`;
- `test:v13-strategy-research`;
- database guard tests;
- fee verification/artifact tests;
- micro-live integration/authorization;
- pair-key/funding/commissioning tests.

The workflow also runs workspace typecheck, paper-strategy parity/regression, full build, disposable PostgreSQL schema initialization, API/forward-test integration, Kalshi client tests, and the index-2 provisioning route.

## Deliberately not enabled by this handoff

This handoff does not:

- merge the branch into `main`;
- enable production execution;
- modify credentials;
- transfer or fund money;
- approve a production live-money policy;
- submit, amend, or cancel a real-money order;
- deploy a production executor.

Those are explicit later decisions after independent review of the implemented executor/ledger and satisfaction of the acceptance gates above.
