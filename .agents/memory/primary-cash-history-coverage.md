---
name: Primary cash history coverage
description: Why a primary-account cash checkpoint is not production-ready without complete authenticated transfer history.
---

Keep primary non-exclusive execution blocked when complete, authenticated transfer history from the durable checkpoint cannot be obtained. A matching available balance is not enough: deposits and withdrawals can offset between snapshots.

**Why:** The currently available account reader cannot establish complete cash-transfer history. An isolated mocked scan proves the reconciliation algorithm, not live coverage; silently accepting it as proof would miss offsetting unrelated movements.

**How to apply:** Require a real cursor-based transfer reader with completeness evidence before reconsidering primary execution readiness. Preserve the original cash anchor and checkpoint across restarts, and freeze on gaps, ambiguity, or unexplained activity.

Official Kalshi Trade API documentation separately lists deposits, withdrawals, own-subaccount transfers, and intra-exchange transfers; a read-only account audit confirmed that the current primary credential can access those GET endpoints. This improves observable coverage but does not establish a universal ledger, historical retention, or a consistent snapshot across paginated scans. An empty transfer response is not proof that no transfer was ever possible.

**Why:** A successful scan of the documented event classes may still miss an undocumented adjustment or an event outside an unguaranteed retention window. A restricted numbered-subaccount key cannot initiate transfers, but the owner or other unrestricted credentials still can.

**How to apply:** Treat an isolated numbered subaccount as a way to narrow the cash boundary, not as proof that external movements are impossible. Any readiness change still needs complete history for transfers affecting that subaccount, a cash anchor, and independent verification of the intended key restrictions; keep the primary mode frozen without them.

For a numbered subaccount on a non-default shard, a cash baseline and every subsequent authenticated activity scan must be bound to the same `(subaccount number, exchange index)` pair. A numeric subaccount selector alone does not identify the cash bucket. An activity checkpoint must carry that pair through its durable digest chain.

**Why:** Broadening a primary-only cash reconciler to accept any valid subaccount number could compare a shard-2 activity ledger to a baseline from shard 0, then incorrectly report that the cash delta reconciles.

**How to apply:** Preserve primary-only legacy behavior until a persisted, independently verified pair identity is available end-to-end. Reject missing or mismatched pair identity at startup, after restart, and before trading; pure mocked accounting with a pair is not evidence that the live reader or database has supplied one.