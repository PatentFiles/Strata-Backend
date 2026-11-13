# BOTH-prefetch qualification candidate

## Scope

Test-only follow-up to merge `0d9c2def02157f6c00886b7d0bf8fab519c20ad8` (tree `a1fe7410d1b1d9b7e39858059f77a1527b5ff494`). No runtime, protocol, authority, deployment or production configuration changes.

- Preserve the original FINAL=true / PREPARE=false CI safety run.
- Add a separate BOTH=true safety job on PostgreSQL 16 and 17.
- Exercise a committed hint through the actual scheduled worker, PREPARE capture, FINAL_MARKET and WIRE_FEE. Cover a completed and pending PREPARE, duplicate dispatch, STOP, original source expiry at 5001 ms and changed pinned price.
- Extend real supervisor construction/callback coverage with three synthetic accounts: two-account/three-request limits, queued STOP isolation, incorrect intent refusal, ignored cancellation retaining transport slots, drainage and unaffected-account continuation.
- Use standalone synthetic arithmetic, public price-grid constants, placeholder identities and generated test IDs. The new cases do not consume the pre-existing historical-expectations fixture.

## Evidence and validation status

The prior frozen local qualification used the exact runtime source of this merge. All 95 supervisor-wiring source inputs and 510 non-test API/shared-library source files matched GitHub blob IDs; the complete repository comparison had only the intended test/CI differences. This establishes source identity, not deployed-image identity.

The frozen PG16 and PG17 BOTH suites each passed 1334/1334 executions across 75 batches, with no failures, cancellations, skips or todos and 28 clean shutdown markers. Each version recorded 28 runner receipts with both flags true. Six distinct active-worker scenarios execute 18 times per version through existing host imports. The aggregate includes the original 12-case wiring harness, not the expanded 13-case version.

The final standalone synthetic-fixture candidate was then tested in a separate checkout: API typecheck passed; the standard `node --test scripts/final-public-supervisor-wiring.test.mjs` entrypoint passed 13/13; the full `personalExecution.integration.test.ts` file passed 46/46 under each PostgreSQL version, including all six sanitized BOTH scenarios (three captured test POSTs and three refusals). Both focused runners reported both flags true, exited zero and shut down their disposable clusters cleanly. YAML parsing confirms the separate PG16/17 job and preservation of the original FINAL-only job. No runtime source differs from the qualification baseline.

The full 1334-execution aggregates belong to the preceding frozen candidate. They were not rerun after the synthetic test-data refactor and wiring expansion. Focused final-candidate checks supplement them; they are not a new full-suite receipt. The proposed GitHub matrix has not yet run remotely. Keep that distinction in any release decision.

## Limits

Public metadata and signed books are synthetic. The worker integration uses real ledger/executor code and disposable PostgreSQL, but private authorization seams remain explicit fixture ports. Supervisor wiring replaces worker scheduling and database/provider boundaries; its concurrency test proves same-owner account isolation, not real cross-owner authority.

Successful synthetic POST observations are captured test transport calls, not exchange orders or fills. These tests do not replay a real trade, prove historical rescue, establish profitability, guarantee latency headroom or authorize live trading. Existing source clocks, pinned economics, fee checks, fencing, STOP, duplicate protection and UNKNOWN/no-send handling remain in force.
