---
name: BTC signal safety
description: Prevent misleading trading signals when quotes or market snapshots change.
---

For any strategy work, compare entry eligibility against the favored side's buy offer, not the bid/ask midpoint. Treat BTC and market-target observations as a matched snapshot. A target or ticker change must not itself count as a fresh BTC crossing, and an out-of-sync snapshot must not remain actionable.

**Why:** A midpoint below the price cap can hide an unaffordable ask; a newly refreshed target paired with an older BTC-derived buffer can display the wrong direction or a false crossing.

**How to apply:** Keep the thresholds unchanged unless explicitly requested. Preserve signed BTC-minus-target logic for direction and use absolute buffer only for magnitude. Fail closed until a coherent BTC/market snapshot is available; keep paper calculations and manual live records separate, with no order execution.