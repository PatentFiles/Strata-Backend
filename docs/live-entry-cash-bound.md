# Conservative whole-contract ENTRY cash sizing

Local release candidate, based on reviewed combined tree `d32eddb36b3c76d5ea37a43f401d486a77591f87`. Offline tests do not establish a production order, fill, liquidity or profit. No policy limit, fee tariff, account alignment assumption or approval is changed.

## Why the previous normal pilot could not enter

The commissioned owned reader's existing conservative model independently budgets hundredth-contract fills, without crediting rebates. Its future EXIT allowance is lost sell proceeds (fee plus balance alignment), not an additional debit of the whole gross sell amount. A gross-first $5 plan at 52 cents selects nine contracts; even the prior nominal-entry-fee treatment exceeds the approved $6.25 all-in ceiling once the existing future EXIT allowance is included. Merely reducing to four contracts using nominal trade fees would still under-reserve fragmented ENTRY cash.

This version uses the already-existing `maximumEntryCashDebitPerContractMicros`, `maximumEntryFeePerContractMicros` and `maximumExitFeePerContractMicros` results. On the verified full four-decimal fixture grid, each contract reserves $1 ENTRY cash and $0.9999 future EXIT lost proceeds; the observed tapered-grid example gives $0.999 instead. Both yield a three-contract pilot: $1.56 worst gross at 52 cents, $3 joint ENTRY cash, $3 rounded EXIT allowance, $6 total. Four require $8 and cannot pass. The configured $5 remains a gross ceiling, not a minimum spend, and $6.25 remains the total ceiling. There is no newly invented $1.25 separate fee ceiling.

## Version and authority

`NON_DIRECT_CENT_FRAGMENTS_V1` is minted only by the commissioned owned market reader after its existing exact ticker/event, quadratic multiplier-one, no override/scheduled change, lifecycle and price-grid proof. It binds policy and artifact digests, market/side, fee metadata/series/grid digests, and the three exact per-contract bounds. A stable semantic model digest is separate from the size/limit-specific receipt digest. These are integrity checks within the existing trusted reader/database boundary, not provider signatures or independent approval.

New LIVE ENTRY requires the versioned envelope and selected-count proof; it cannot fall back to nominal fee arithmetic. The older global `createProductionExchange` reader remains unchanged and does not mint this stronger proof because it lacks the same event/schedule completeness checks; fresh LIVE entries through it fail closed. The supported commissioned personal route supplies the proof. Historical intents with neither versioned field retain legacy reconciliation. Partial stripping of either field is refused, never interpreted as legacy. Every new ENTRY fill also verifies its stored capability digest, so ordinary deletion of both fields with an unrepaired checksum fails closed; fully recomputed malicious database forgery remains outside this integrity checksum's trust boundary. Existing actual UNKNOWN recovery and no-send provenance remain unchanged.

## Sizing and immutable final request

Before testing full selected depth, choose the maximum whole count allowed by the minimum of current cash, remaining capital, all-in maximum, and remaining daily/total loss limits. Existing configured gross maximum, signal reference/caps, actual signed depth and one-position/idempotency checks still apply. No book quantities are fabricated. The owned reader's existing top-price fee basis is retained: this is not permission to walk more expensive depth or maximize gross expenditure.

Prepare stores selected count, original limit, exact cash/trade/exit micros, upward-cent reserves, effective budget, semantic identity and receipt fingerprint in the existing decision JSON and capability digest. Total reservation is joint ENTRY cash plus future EXIT allowance; gross and trade fee are not added twice.

A controlled legacy test proves exact reoptimization rejects a safer 49-cent book after preparing at 50 cents. Only the new version instead checks admissibility of the pinned original request: same BUY/IOC/side/source/count/limit, source ceiling, fresh same semantic tariff/grid/approval, enough real depth at or below that limit, original unchanged reserve and current cash/capital/loss support. Fresh size-specific receipts may differ; semantic changes cannot. It never increases count, raises or lowers the actual order limit, changes the request digest or releases original reserve. Legacy final equality remains unchanged.

## Actual-fill accounting

For exact hundredths quantity `q` and actual dollar-micro price `p`, actual gross is `q*p/100`. The verified multiplier-one trade fee is rounded up in exact integer arithmetic:

`tradeMicros = ceil(7*q*p*(1000000-p) / 10000000000)`.

The one-fill BUY net-fee ceiling is `ceil_to_cent(actualGross + tradeMicros) - actualGross`; it must also fit the verified per-unit trade-fee envelope. This follows the documented signed-revenue rounding mechanics and assumes no rebate. The cent lattice contains the centicent lattice, so this remains conservative for either membership class without inferring account applicability. [Kalshi fee rounding](https://docs.kalshi.com/getting_started/fee_rounding).

Independently, cumulative actual ENTRY gross plus net fees must not exceed the pinned cash bound scaled to actual filled hundredths. Better-price fills do not lose access to their unused gross component, but absurd whole-fill fees cannot spend unused worst-case fragmentation reserve. Authenticated excessive fees/cash still record real exposure and block further authority; they are not silently erased or treated as flat. Overfills, identity/gross/limit mismatches and unexplained external cash retain existing freezes. The original full future EXIT reserve remains held while any owned quantity exists. New envelopes scale future EXIT reserve from exact per-unit bounds before cent rounding, avoiding a second scaling of an already-rounded larger basis; legacy scaling stays unchanged.

## Rollout and rollback

No schema migration or data backfill is added by this delta: existing fee/decision/request JSON and numeric reservation columns hold the new proof. This delta depends on the reviewed combined book/held/fractional candidate, whose additive SQL prerequisites and deployment hold still apply. Existing rows are not rewritten. No production migration or deployment is authorized by this document.

Do not downgrade runtime while any new-version intent/residual position is live: older code would not enforce the new ledger bounds and uses different fee fingerprints. Remain disarmed; drain/reconcile under compatible code or deploy a reviewed compatibility rollback. Never strip proof fields or rewrite a dispatched request to force compatibility. Old unresolved PREPARED entries may be refused by the new LIVE requirement and must follow existing known-not-posted expiry/recovery, never replay.

## Local evidence and limits

- 80 real disposable-PostgreSQL financial acceptance cases, including unchanged legacy/UNKNOWN/no-send/fractional behavior and new affordability, final pinned order, forged/stripped proof, actual loss/cash, 100 fragmented fills, exact one-fill ceiling, cumulative excess and overfill checks.
- 26 actual owned personal route PostgreSQL cases, including both sides' fractional protective EXIT and immutable private signed fences.
- 7 exact arithmetic units, including all budgets 1..1000, semantic mutation, depth and per-fill rounding, and exact future EXIT scaling.
- Existing planner 9, risk 14, preflight 7, personal read/authority 33, fractional fee 5 (600,000 bound comparisons) regressions; API types and build.
- Full combined safety suite remains the integrator's release gate; focused checks are not a replacement. No live order success is claimed. Five-second freshness, market windows, approval renewal, SCOUT/CONFIRM semantics, reference prices, owner exit floor and all monetary limits remain unchanged.
