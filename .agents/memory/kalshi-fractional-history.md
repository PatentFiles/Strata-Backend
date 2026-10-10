---
name: Kalshi fractional account history
description: Exchange count precision and the safety boundary between unrelated account activity and bot sizing.
---

Kalshi documents `_fp` contract quantities as strings with up to two decimal places, response values with two places, and 0.01-contract granularity. The published FixedPointCount schema does **not** specify a numeric maximum. In a complete development read-only primary-account scan, many unrelated fills were positive fractional quantities and every retrieved fill sum matched its corresponding authenticated order's filled total exactly. Use an explicit conservative internal bound rather than inferring an exchange maximum.

**Why:** An integer-only account-history check rejected unrelated activity before attribution even though it was documented exchange data. Widening bot contracts or rounding decimal counts would create a different safety problem.

**How to apply:** Compare unrelated-market fill sums with complete authoritative order totals using exact hundredth-contract units. Require complete current and archived coverage. Keep bot sizing and bot-fill requirements independent; never infer a fill belongs to the bot merely because it appears in shared primary-account history. Block malformed, excessively precise, nonpositive, out-of-range, missing, and mismatched evidence.