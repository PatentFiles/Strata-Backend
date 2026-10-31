# Exact fractional protective EXIT quantities

Engineering-only candidate. No live order/fill is established by offline tests.

## Quantity authority
ENTRY remains a whole integer `contracts` request. Newly prepared protective EXIT requests use `quantityVersion: EXIT_HUNDREDTHS_V1` and canonical positive integer-string `quantityHundredths`, with no `contracts` property. The exact helper rejects mixed versions, new BUY/nonreduce-only/nonIOC requests, malformed precision and quantities above100000 hundredths (existing owned1000-contract maximum). Legacy whole requests remain readable and retain their existing JSON/digests. No history backfill is performed.

The EXIT-only planner works in integer price ticks and contract hundredths. Gross proceeds are exact integer micros (hundredths times price ticks); actual bid liquidity, owned quantity, existing maximum and owner floor bound every plan. It never rounds inventory upward. Partial fills/remainders remain owned until fresh authenticated reconciliation and a separately prepared new identity. Existing exit triggers, risk, five-second freshness, reviewed fees, IOC policy, one-use marker and unknown-outcome rules are unchanged. No FOK switch or new liquidation trigger.

Fee reservation uses an independently reviewed helper that conservatively scales the existing verified integer fee basis, rounding upward in BigInt. It does not invent a new model or solve unrelated ENTRY fee-cap incompatibility. The ordinary approved fee identity/age and remaining parent reservation still apply. A currently observed ENTRY fee-cap mismatch remains a separate release blocker until resolved; this patch must not be presented as fixing it.

## Atomic dependencies
Merge/deploy this core only together with the reviewed fractional fee helper and private quantity-binding patch. Apply NEW `sql/strata_protective_exit_fractional_quantity.sql` after prior migrations and BEFORE runtime. Do not edit or rerun an older trigger definition after this migration. It supplies the exact request SQL helper and updates the no-send immutable audit guard. Private reserve, UNKNOWN, final signed fence and no-send cleanup all bind the same quantity. Existing position/reservation columns already store hundredths; the financial request/decision/capability JSON includes the version and exact quantity automatically.

Rollback must remain disarmed with no in-flight new-format intents; old code cannot safely process the new request representation. Do not strip quantity fields or rewrite a dispatched capability to roll back.

## Evidence
Author validation:64 disposable-PG financial acceptance tests;26 actual owned integration tests;5 exact planner/quantity/display tests; API typecheck/build. The owned integration uses actual DB financial preparation, seal, reservation, UNKNOWN commit, SQL final-release fence, actual RSA signing with a synthetic key and intercepted raw fetch, default immutable private reconciliation, and ledger reconciliation. Both YES/NO0.01,0.50,1.50 full fills;1.50 partial0.25 followed by owned1.25 and new preparation; transport uncertainty/no replay; known no-send cleanup; and post-marker quantity/side/price tampering are covered. Synthetic provider evidence is injected only at supported test seams in the network-fenced disposable runner. These tests do not prove production market liquidity, actual exchange acknowledgement/fill, or prevention of later failures.
