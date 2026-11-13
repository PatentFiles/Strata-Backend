---
name: Kalshi new subaccount visibility
description: New zero-balance subaccounts can appear in netting before all-subaccount balances; scoped balance breakdown can be misleading.
---

Do not equate a missing row in the all-subaccount balances GET immediately after creation with absence of a newly created zero-balance subaccount. Recheck both inventory views and the exact subaccount's scalar balance through authenticated GETs. A successful creation response may return only the numbered subaccount, not its exchange index; do not infer shard identity from that response alone. Do not use the `balance_breakdown` inside a subaccount-filtered balance response as proof that the subaccount owns the displayed shard cash unless it reconciles to that response's scalar balance and the all-subaccount rows.

For a newly created and still-empty pair, the all-subaccount balance inventory's `updated_ts` may remain at the creation time while the scoped zero-balance GET reports the time of each read. The timestamps need not be within 30 seconds to describe the same unchanged zero cash. Require fresh scoped evidence, matching exact pair cash, complete activity history, and zero portfolio value instead of treating this timestamp difference alone as a nonzero balance.

**Why:** Immediately after a successful create response that supplied a number but no exchange index, the netting inventory listed the new account while all-subaccount balances did not. A later GET listed its zero-balance row. The subaccount-filtered balance GET showed scalar zero but a breakdown matching cash held elsewhere in the primary account. Later, its unchanged zero inventory row kept the creation-time timestamp while scoped reads advanced their timestamps by more than 30 seconds.

**How to apply:** Use netting inventory for early identity visibility, wait for the zero-balance inventory row if needed, and prove the intended `(subaccount, exchange_index)` pair independently before accepting creation. Verify emptiness with exact pair balance, orders, positions, fills, and settlements. Report contradictory breakdown fields rather than attributing that cash to the new account.