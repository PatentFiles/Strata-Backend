---
name: Kalshi pair funding provenance
description: Limits of official Kalshi history for a dedicated shard/subaccount cash anchor
---

Treat a cross-exchange transfer involving the target shard as unscoped unless an independently authenticated record positively identifies the source and destination subaccounts. Official list and single-transfer GET responses expose source and destination shards, amount, and status, but not the source or destination subaccount numbers, even though the POST accepts those numbers. A matching amount or later balance is not attribution.

**Why:** Such a transfer can change a numbered subaccount's cash, while an unrelated transfer on the same shard has the same documented response shape. Neither can be positively assigned to the pair or elsewhere from that history alone.

**How to apply:** Use a prospective clean boundary for a newly created pair. Retain earlier cross-shard history as ambiguous without assigning it to the pair; do not demand impossible historical attribution before a signed $0/zero-exposure snapshot. Any new unscoped shard-2 transfer after the clean boundary must freeze MICRO_LIVE, including one before the $25 anchor. A later matching balance must never clear that freeze; further entries require explicit review and a new checkpoint.

An authenticated current pair-scoped available balance is documented at GET portfolio/balance with both subaccount and exchange_index. It does not prove what the pair balance was before a transfer.

**Why:** The documented historical transfer records and current balance endpoint do not provide a historical zero-balance snapshot. A caller-supplied timestamp, digest, or authenticated flag is not proof that the server observed zero before funding.

**How to apply:** Persist a trusted server-observed zero cash and zero-exposure snapshot before funding, then observe the exact completed $25 transfer and a fresh scoped balance. Do not accept a caller-supplied authentication flag or digest as a substitute; withhold execution readiness until holds, fee-once accounting, and activity-bearing restart/exit recovery have been proven.

An authenticated inventory-balance GET can still report an `updated_ts` from hours earlier. On the observed funded pair it remained at the transfer time while a fresh signed GET returned the correct cash; this timestamp describes the last cash change, not the GET observation.

**Why:** A delayed reconciliation cannot honestly claim its post-funding snapshot was captured within 60 seconds of the transfer. Treating the old last-change timestamp as stale would reject a genuine current balance, but ignoring the snapshot-age rule for all attempts would let uncertain or lost-response transfers gain an unearned anchor.

**How to apply:** Bound any late-anchor exception to the durable successful POST response, independent source/destination cash conservation, unique exact transfer history, a fresh signed read, and complete no-activity evidence. Keep uncertain attempts fail-closed, and retain the actual late observation time rather than backdating it.