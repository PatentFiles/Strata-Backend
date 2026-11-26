# Owner cash transfers — qualification and rollout

This release is not authorization to transfer money or start a worker. Preserve
all existing owner stake, policy, loss limits, original funding and trade records.
The stake/capital ladder drafts #390/#250 remain separate staging work.

## Current contract

- Withdraw only to the same owner's Kalshi primary cashier (subaccount 0,
  exchange index 0) from bot subaccount 1 / index 2. Bank withdrawal stays in Kalshi.
- Retain max(5 × saved entry stake, owner-selected minimum), plus reserved cash.
  Never infer the stake from a browser value. Recheck its revision at final send.
- Automatic sweeps are off unless an explicit current owner rule enables them.
  Existing fixed-amount rules remain fixed. An excess rule sweeps whole-cent cash
  above the protected floor after pausing entries and confirming flat exposure.
- Deposits/withdrawals use a separate immutable capital-flow receipt ledger.
  Opening capital and trading P&L do not change. Ledger conservation includes
  verified net funding and checks it against receipts.
- A durable withdrawal claim and financial hold precede one provider POST.
  Unknown outcomes are never retried. Provider receipt and exact signed cash in
  all three affected buckets are required before accounting and hold release.
- Signed balance display is independent of money-moving authorization; it is
  available while running, with an observation timestamp. It does not grant
  permission to transfer or certify profitability.

## Release gates

Run `test:owner-cash-transfers` and `test:owner-cash-transfers-native`, full
protected backend checks, frontend checks, and integrated native browser tests.
Migration: `supabase/migrations/20261126183644_owner_cash_flow_accounting.sql`.
It adds only schema/default-zero projection; it neither opts in customers nor
moves money. Check actual applied schema, runtime grants, and zero receipt rows.
Deploy compatible code before authorizing any transfers. New capability is
`STRATA_OWNER_CASH_TRANSFERS_V1_ENABLED=true`, additional to existing manual,
automatic, routing and top-up gates. Do not set it on an unqualified release.
No real-money canary is included in automated qualification.

## Rollback

Disable new transfer capabilities first. Preserve readback/reconciliation and
any unresolved financial hold. After the first capital-flow receipt, do NOT
roll back to software that ignores net funding, delete receipts, rewrite opening
capital or trade P&L, or retry a provider transfer. A compatible correction must
continue recognizing the append-only capital-flow ledger. Owner ARM/START and
new risk/stake approvals remain separate deliberate actions.
