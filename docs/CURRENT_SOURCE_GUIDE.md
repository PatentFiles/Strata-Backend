# Current Strata source and verification guide

Reviewed against backend main `0bdbf1da76da1919f88f3278a883e4646548d8d1`
on November 4, 2026. This is a source map, not a production health check or
permission to trade, deploy, change account state, or issue an approval.

## Execution layers are separate

- The original browser paper dashboard is in
  [`artifacts/btc-paper-dashboard`](../artifacts/btc-paper-dashboard).
  The active external Strata frontend is maintained separately in
  [Meta-UO/TradingApp](https://github.com/Meta-UO/TradingApp). A frontend build
  or backend merge does not prove either published deployment is current.
- The server paper producer is
  [`forwardTestWorker.ts`](../artifacts/api-server/src/lib/forwardTestWorker.ts).
  Paper results, optional research, and shadow observations are not signed
  exchange fills or realized live returns.
- The legacy, bounded development micro-live harness is
  [`microLive.ts`](../artifacts/api-server/src/lib/microLive.ts).
  Its development-only guard is not a description of the separate production
  execution path and must not be relaxed to enable production.
- Owner-scoped production sessions are constructed in
  [`sharedPersonalTradingControls.ts`](../artifacts/api-server/src/lib/strata/sharedPersonalTradingControls.ts)
  and [`personalExecutionSupervisor.ts`](../artifacts/api-server/src/lib/strata/personalExecutionSupervisor.ts).
  The actual executor and durable ledger are
  [`executor.ts`](../artifacts/api-server/src/lib/v13-production/executor.ts)
  and [`ledger.ts`](../artifacts/api-server/src/lib/v13-production/ledger.ts).
- Current Strata authentication is implemented in
  [`supabaseAuth.ts`](../artifacts/api-server/src/lib/strata/supabaseAuth.ts).
  Legacy Clerk routes elsewhere in this repository do not define the current
  owner authentication or authorization contract.

## Safety and release references

- [Continuous owner-grant review](reviews/continuous-grant-20261027.md):
  standing consent, short technical renewal, revocation, and exact-SHA scope.
- [Owner renewal history](commissioned-never-posted-release-renewal.md) and
  [`reconciledReleaseRenewalHistory.ts`](../artifacts/api-server/src/lib/strata/reconciledReleaseRenewalHistory.ts):
  never-posted and reconciled historical activity are distinct proofs.
- [Book-priced entry evidence](live-entry-book-evidence.md),
  [cash bounds](live-entry-cash-bound.md), and
  [selected-depth fee proof](selected-depth-entry-fee-proof.md).
- [Fractional protective exits](fractional-protective-exit.md),
  [actual protected dispatch review](reviews/protective-actual-authority-dispatch-20261103.md),
  and [provider freshness review](reviews/protective-provider-freshness-20261103.md).
- [BOTH-prefetch qualification](reviews/both-prefetch-qualification-20261103.md):
  public read overlap is not authority, cached order-book permission, or a
  freshness extension.

Do not merge or deploy cleanup while a live validation session relies on the
current exact-SHA approvals. Even documentation-only commits change the Git SHA.
Use an isolated candidate, then a separately authorized stopped/flat release
procedure with fresh reconciliation and the required exact-SHA qualification.
Never copy historical consent or modify financial records to make a release
appear eligible.

## Local checks

Use the repository's pinned pnpm version and installed dependencies.

```sh
pnpm run typecheck
pnpm --filter @workspace/api-server run test:offline-regression-gaps
pnpm --filter @workspace/api-server run test:v13-safety-all
```

The offline regression runner uses synthetic credentials, an inert database
stub, and loopback-only network access for local HTTP route tests. It does not
start a database or read the shell's database/exchange credentials.

The full safety aggregate includes database-backed tests. Use only the existing
disposable PostgreSQL harness or its pinned GitHub Actions database. Never point
it, a schema-push command, or a test migration at a connected production database.

The existing [V13 workflow](../.github/workflows/chatgpt-v13-diagnostics.yml)
runs the safety aggregate in its ordinary job and PostgreSQL 16/17 BOTH-prefetch
jobs. The [CI usage policy](GITHUB_ACTIONS_RUNNER_COST_POLICY.md) explains path
filters. A skipped workflow is not a passing check. Inspect every relevant job
for the exact candidate SHA before release.

## Interpreting old issues and documents

Many October issue bodies record an incident-time SHA, expired receipts, an old
account snapshot, or a proposed implementation. Those are historical evidence,
not assertions about today's account or deployment. Check the latest code,
merged successors, dated comments, and fresh authorized runtime evidence before
closing an operational acceptance issue.

Passing tests establish only their stated behavior. They do not prove current
exchange exposure, actual live fills, protective-exit execution, net profitability,
or capacity for more than the owner-approved position/risk limits.
