---
name: Kalshi canonical NO exits
description: External authenticated evidence and safety rule for a legacy NO-sell order paired with a YES-sell fill
---

An authenticated historical NO-sell order and its YES-sell fill shared the exact exchange order ID, ticker, action, quantity, and canonical `outcome_side=yes` / `book_side=bid` fields on both records. The fill supplied both YES and NO execution prices, strictly complementary to $1, and its fee. Kalshi's documented direction mapping treats sell-NO as YES/bid; the old `side` representation is not by itself the economic leg. The market order's displayed NO quote was not its execution price.

**Why:** Complementary prices alone do not establish order ownership or cash flow. The authenticated pair was an older external account trade, not a local strategy fill. Its NO-leg net proceeds and resulting position can be corroborated from fills and aggregate settlement, but no historical balance ledger independently proved the cash movement.

**How to apply:** Require exact exchange-order linkage, matching action and canonical direction on both records, positive complementary named execution prices, and corroborating quantity and fees before interpreting a mismatched legacy-side fill as a NO exit. Reject incomplete or contradictory metadata. Do not infer execution price from a market-order quote, attribute an account-wide settlement to a bot position, or treat derived cash arithmetic as a captured balance delta.