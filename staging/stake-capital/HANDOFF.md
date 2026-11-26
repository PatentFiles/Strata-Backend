# Strata stake and capital reference

The deployed account currently uses the **20% allocation preset, revision 1**.
Its saved policy is **$5 maximum gross / $6.25 maximum all-in** with a
**$25 policy capital limit**, **$10 daily loss ceiling**, and **$15 total loss
ceiling**. The table below applies that same preset's arithmetic as an
illustration. It is not a recommendation, an approval to increase loss limits,
or a list of amounts to deposit.

| Gross entry cap | Minimum verified spendable cash for this preset at setup | All-in entry cap | Daily loss ceiling if scaled | Total loss ceiling if scaled |
|---:|---:|---:|---:|---:|
| $5 | $25 | $6.25 | $10 | $15 |
| $15 | $75 | $18.75 | $30 | $45 |
| $25 | $125 | $31.25 | $50 | $75 |
| $50 | $250 | $62.50 | $100 | $150 |
| $100 | $500 | $125 | $200 | $300 |
| $150 | $750 | $187.50 | $300 | $450 |
| $200 | $1,000 | $250 | $400 | $600 |
| $250 | $1,250 | $312.50 | $500 | $750 |
| $500 | $2,500 | $625 | $1,000 | $1,500 |

The second column is the preset's reference capital, not account equity,
a deposit instruction, or an amount needed for every order. At setup the
strict preset requires this amount in freshly verified cash **after**
existing reservations. The runner confirmed that the exact amount passes
the preset's calculation and one cent less does not, for all nine rows.

At order preview, available cash, remaining approved capital, both remaining
loss allowances, and a free position slot matter independently. Required cash
for a particular modeled order is its modeled all-in reservation (entry cash
and modeled protective-exit allowance), not the full preset capital. The
Wallets preview also shows the shortfall to cover the *entire* approved all-in
ceiling even when a smaller modeled order is possible. Cash in the account
does not change the approved policy, reopen a blocked account, or replace
signed fee terms. If the $10/$15 loss ceilings stay in place, funding a $15
gross tier does not make a full $18.75 reservation executable: the current
remaining loss budgets are smaller. No limits were changed.

## Wallets behavior
For a rung with a current verified approval, the staging panel shows the
applicable per-order cash and capital shortfalls. It returns an explicit
unavailable status rather than inventing account-specific numbers when the
rung is not yet approved. Keep this reference alongside the selector so the
user can look up higher tiers before approval. The companion displays the
reference automatically if the authenticated profile matches the exact preset. This standalone companion
is not mounted in production and cannot save a stake. A future save flow must
validate fresh cash, exact policy and fee authority, stopped and reconciled
state, and versioned owner approval before an increase. It should show the
current and proposed limits side by side and never scale loss limits silently.

## Hosted check
There is no exchange-verified read-only signer connected to the isolated runner.
Keep the package inert until that dedicated capability is verified and securely
bound in the private Railway service. Do not send API secrets through chat, copy
production keys, or treat a synthetic run as hosted evidence.
