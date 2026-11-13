---
name: Kalshi exchange-scoped cash
description: Order affordability must be checked against the market's exchange index, not only aggregate account cash.
---

For any proposed Kalshi order, treat the effective account identity as `(subaccount, exchange_index)`. Immediately before submission, verify the market's current exchange index and check cash for that exact pair. An aggregate balance can be positive while the target exchange index has zero cash.

**Why:** A read-only preflight saw positive aggregate primary cash, but a single separately authorized order submission was rejected for insufficient balance; follow-up GETs showed zero cash on that market's exchange index.

**How to apply:** Carry this rule into MICRO_LIVE preflight and recovery work when separately authorized; aggregate balance is informational only and must never establish order affordability. Do not transfer funds or change accounts implicitly to resolve a shard-specific shortfall; require separate authorization.

The existence of a numbered subaccount on one exchange index does not establish that the same number is provisioned on another index. A scoped balance GET returning zero is not enough: compare the all-subaccount balance inventory and netting inventory for the exact `(subaccount, exchange_index)` pair before calling it fundable.

**Why:** During a GET-only KXBTC15M funding investigation, the market and primary fills identified the crypto shard, while both subaccount inventories listed the dedicated account only on the default shard. A zero balance GET on the crypto shard alone would have concealed the provisioning gap.

**How to apply:** Keep market-shard identification separate from subaccount-shard readiness and key usability. Do not assume a transfer creates the missing shard instance; require separate authorization and post-provisioning GET evidence before funding or trading.

Kalshi's public V2 shard guide points to Create Subaccount with an `exchange_index` to provision on a new shard, but the documented create request has no target subaccount number or idempotency key. The response assigns a sequential number, and the docs do not specify per-shard numbering or duplicate-pair behavior. This is not enough to construct a safe request for an *existing exact numbered subaccount*.

**Why:** A dedicated account was present on the default shard but absent on the crypto shard. Sending the documented create request speculatively could create a different numbered account, which cannot be undone by validating the response afterward.

**How to apply:** Before implementing or authorizing a one-shot create for a specific `(subaccount, exchange_index)` pair, obtain an authoritative contract for exact-number targeting/assignment, already-existing behavior, and side effects. GET inventory alone establishes absence, not how an irreversible POST will allocate the next number.