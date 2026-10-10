---
name: Kalshi transfer reconciliation
description: Async shard-transfer recovery needs bounded GET retries and careful account attribution.
---

An accepted intra-exchange transfer may return a transfer ID before that ID is visible to the single-transfer GET endpoint. Treat an initial 404 as inconclusive and continue bounded GET-only reconciliation; never resubmit the POST. The documented exact-transfer and history records may omit source and destination subaccount numbers, so matching an ID, amount, shards, and primary-balance deltas establishes strong economic evidence but does not directly prove the subaccount fields from the exchange record.

**Why:** A one-cent primary-to-primary shard transfer returned HTTP 200 with an ID; its first immediate GET returned 404, while a later GET and history showed completion and the expected primary-balance changes. The returned transfer record did not expose subaccount numbers.

**How to apply:** Persist the ID before any reads; retry only GETs within a fixed window, compare history and exact-record identity against the intent, inspect both scoped balances and aggregate cash, and report the subaccount-record attribution limitation explicitly rather than claiming direct verification.

Do not conflate the intra-account transfer endpoint above with the dedicated subaccount-to-subaccount transfer endpoint. Kalshi documents the latter as taking a unique client UUID and a cent-denominated amount on one exchange index (default 0), returning HTTP 200 with an empty body. Its paginated history includes server transfer IDs, source/destination subaccounts, amount, index, and time, but does not document echoing the client UUID or a definitive duplicate-ID response.

**Why:** A GET-only funding preflight found ample aggregate primary cash but only one cent on the transfer endpoint's default exchange index. The dedicated endpoint's empty success response also means a generated transfer ID cannot simply be saved from POST as with the distinct intra-account endpoint.

**How to apply:** Require an explicit exchange-index choice with sufficient scoped source cash. After any separately authorized POST, reconcile the entire history and scoped balances; persist the server ID/time/evidence only after an unambiguous match. A timeout or uncertain response must freeze progression, not trigger an automatic retry with a new or repeated UUID. Avoid claiming a client UUID can be looked up by a documented endpoint unless current docs prove it.

For a one-use subaccount transfer, an HTTP-200 empty response can establish acceptance, but documented GET history has no client UUID. A lost response followed by one economically matching transfer and exact balance changes is not proof that this client request caused it; keep such an attempt consumed and require manual review rather than automatically advancing its funding boundary.

**Why:** An independent identical transfer can satisfy the same amount, pair, and balance checks after a lost POST response. Once a one-shot network mutation has been attempted, repeating it risks a duplicate.

**How to apply:** Persist the one-use latch before POST. After a timeout or restart from an unacknowledged state, use GETs to inspect the economic result and report the uncertainty, but never resubmit or equate a matching history record with an echoed client UUID.

Kalshi balance `updated_ts` can represent the most recent cash change, not the time of the signed GET. A stable balance observed after a delayed restart can legitimately carry an old update timestamp.

**Why:** Rejecting an authenticated balance GET solely because no cash changed for a minute can make a successful one-shot transfer permanently unreconcilable.

**How to apply:** Keep GET observation time separate from balance-change time. Require a current signed read, and use change time to prove that post-transfer cash updated after the transfer rather than to impose an arbitrary age limit.