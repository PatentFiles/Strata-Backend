# Conservation aggregate batching — LOCAL candidate only

Base exact deployed fcedd7459ad3ede704d09130d5484bb97d06600f/treef3af6c845077cc149369be483f5f1cf021ac9cb8. Separate from final-comparison diagnostics; no publication/deployment or production/provider read performed. No migration required.

## Change and invariants
`ProductionLedger.assertConservation` reads the same complete per-account event, position and intent histories. Three independent aggregate subqueries, each guaranteed one row even when empty, are CROSS JOINed into one statement. This is NOT a join of raw histories and cannot multiply totals. Five sums retain COALESCE0/text/BigInt semantics. The exact four equations remain:
1. cash = initial cash + journal cash delta;
2. cash + position basis = initial cash + journal realized PnL;
3. position realized PnL = journal PnL;
4. reserved account cash = sum of intent reserves.
Same `production_money_conservation_failed` refusal, freeze callers, account ID binding, account `FOR UPDATE` transaction and rollback behavior. No extra connections, provider reads, parallel tick, cached proof, skipped reconciliation, new authority, altered price/freshness/fee/risk or shortened history. Single statement obtains one coherent MVCC snapshot instead of three consecutive statement snapshots. Normal financial writers remain serialized by the existing account lock; out-of-protocol privileged DB mutation is not newly authorized.

This removes exactly two SQL requests per conservation invocation, not history work. Complexity remains proportional to full account history; this does not solve eventual order/fill pagination growth or prove history was the dominant latency in either observed flat event. No ledger persist/update batching or protected afterReconcile changes included.

## Offline validation
Actual disposable PostgreSQL acceptance:84/84 pass. A test-only DifferentialConservationLedger executes the old three SELECTs and compares all five returned totals to the new production query on every fixture conservation call across existing empty, reserved, whole/fractional fill, partial fill, exit, settlement, corruption and rollback cases. Production uses only one query; the extra old reads exist ONLY in tests.
Additional actualPG tests show a concurrent same-account UPDATE gets bounded lock timeout while conservation runs; a different account update succeeds and deliberately nonconserving other-account events/positions/reservations do not contaminate target totals. A corrupt in-transaction cash/revision write rejects and rolls back. Two focused unit tests explicitly count one request and independently corrupt each of five totals; unchanged refusal verified.

Bounded benchmark, local empty account, alternating old/new order, no performance pass/fail threshold:
-20 rounds, no injected delay: old60queries vs new20; old mean0.491919ms, new0.283872ms.
-5 rounds with synthetic5ms delay before each query: old15queries vs new5; old mean16.366515ms, new5.664027ms.
Logs /tmp/strata-conservation-pg.log. Earlier run had0.349/0.244ms raw means; variation is expected. Synthetic difference illustrates removed roundtrips, NOT measured Railway improvement, exchange latency or probability of filling. No claim to save the entire prior233–249ms ledger stage; actual stage includes many other queries/locks/work.

## Release discipline
Keep current live process untouched. A future controlled held release requires independent review/combined tests, exact deployment identity, no unresolved exposure/UNKNOWN, fresh read-only account proof and normal approvals. Compare comparable production stage distributions afterward; original immutable signal/limit and5-second source limit remain. The first51→52 refusal and later pinned38 refusal cannot be claimed recoverable from this batching. Earlier arrival does not guarantee price availability, execution or profitability.
