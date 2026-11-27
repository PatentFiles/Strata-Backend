# Signed-history recovery — unchanged C52/C53 strategy

A live IOC received HTTP 201, then the first signed account history could not be mapped. The timer stopped with an UNKNOWN intent and a retained risk reservation. Later complete authenticated GETs mapped through the same existing parser: three YES contracts filled at $0.46, $1.38 gross, $0.0522 fee, and $3.00 settlement, net $1.5678. No original rejected provider body survives; do not label this as a proven field-specific parser defect.

The account was repaired through existing held ledger reconciliation, after exact terminal/flat evidence and a separate operator-requested durable fence. The held transaction conserved cash, stored one fill and one settlement, and released the validated reserve. It did not place an order, alter financial terms, record AAL2 consent or restart a worker.

This release adds fixed-category private mapping diagnostics and a separate runtime reconciliation error in History. The public failure contract and every mapping invariant remain unchanged. It integrates PR #405 ARM latency changes without reverting #404.

Deployment qualification must run the existing same-session UNKNOWN recovery suites (including native PostgreSQL, partial fills, protected exits, revocation and ambiguous outcomes) before enabling STRATA_UNKNOWN_ENTRY_PROTECTIVE_RECOVERY_ENABLED=true. That existing pathway closes new entries, retains the worker fence, retries authenticated reads at most three times within fifteen seconds, and never retries order submission. Protective management is permitted only after successful financial reconciliation. Unresolved, failed or expired recovery remains held.

The old C52/C53 classifier, parameters, price ceilings, fees, loss limits and policy hash remain unchanged. A separate experimental strategy is not part of this repair.

Rollback: disable the recovery feature on a qualified build only after verifying there is no managed exposure. Preserve every order, financial event, evidence receipt and account reserve. Never clear UNKNOWN or credit a settlement by hand.
