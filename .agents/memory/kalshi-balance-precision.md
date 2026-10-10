---
name: Kalshi balance precision
description: Why a nominal trading fee schedule alone cannot bound micro-order cash and exit costs.
---

For a hard all-in micro-dollar risk cap, distinguish the fee model's calculation precision from the account's **balance precision**. Without independently verified direct-member precision, use the non-direct $0.01 balance alignment when bounding each possible fractional fill; do not silently use the fee PDF's $0.0001 centicent example or rely on order-level rebates for a hard worst-case reserve. A conservative bound can make a $1 all-in validation impossible, which is a reason to block, not a reason to weaken the calculation.

**Why:** Kalshi's fee schedule describes rounding for fee plus position cost, but its separate fee-rounding guide specifies $0.0001 target balances for direct members and $0.01 for non-direct members. It also describes six-decimal trade fees, per-fill signed-revenue rounding, and per-order rebates capped so net fees stay nonnegative. The fee schedule alone does not establish the account's rounding behavior.

**How to apply:** Consult the current official fee-rounding guide as well as the current schedule; account for minimum fractional fill size, signed buy/sell revenue, price improvement, account balance precision, and potentially withheld rebates. Require independently verifiable narrower account-specific evidence before using a less conservative bound. Preserve a persistent reservation even when conservative evidence makes the proposed cap unusable.