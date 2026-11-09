# Bounded recovery after an acknowledged, unreconciled entry

Status: offline design and pure scheduling prototype, based on backend commit 29239e42fcdb1bf5b0223b0ae421b0cfea5705b5. Not wired, deployable, or trading-authorized. No current safeguard is relaxed.

## Feasibility finding

A bounded authenticated read-recovery path is feasible. Automatic protective selling while the entry remains unreconciled is not safe: HTTP acknowledgment does not establish fill quantity, and missing history does not establish absence. First reconstruct and commit exact signed financial history through the native ledger. Only then can a separately authorized protective-only worker consider an exit.

Current source constraints:
- v13-production/worker.ts reconciles before consumeOwnedPosition and stops on personal_exchange_history_unreconciled.
- v13-production/executor.ts reconcile invokes afterReconcile, including renewal behavior. It must not be reused as an allegedly read-only retry.
- ownerUnknownRecoveryPlan.ts requires durable KILL, terminal orders and exchange-flat positions. Keep this existing owner accounting operation unchanged.
- ownerFeeEmergencyExitReserve.ts requires execution enabled, kill false, an owned lease and current fencing token. KILL intentionally stops protective automation. Never reinterpret KILL as entry-only hold or bypass those predicates.

## Proposed stages, requiring separate integration review

1. Reuse the existing durable STOP entry hold (owned lease with arm_requested=false), separate from KILL. Atomically fence new entries and all existing entry writers, retain unresolved entry reserve and record incident identity. Scope to exact owner/account/intent, policy, credential fingerprint and lease token. Owner KILL still terminates protection. Do not wire automatic recovery until all entry paths and multi-process races are covered.
2. Independently authorize a bounded seven-feed signed read with existing server-owned credentials and original history floor. Maximum three attempts, 15 seconds total including waits, one in flight. Per-request deadlines/cancellation must stop pending transport; the prototype itself has no timer or cancellation. Recheck lease/account/policy/credentials before and after await. No raw user-provided snapshot, alternate signing route or weaker mapping.
3. If complete authenticated evidence still fails, stop read recovery, retain all holds and alert with scoped reason. Never synthesize a position or infer zero exposure from empty feeds. A parser failure requires a real fix, not a retry bypass.
4. If evidence passes, use an open-position-specific, separately reviewed held-context ledger transaction. Require exact immutable order/fill attribution, terminal entry, complete history, cash conservation and fees, and exact local/signed position agreement. Lock all independent transfer/protective activity and validate schema/FK fences. Commit a receipt bound to post-ledger account revision and financial digest. Preserve freezes and entry hold. Ambiguous COMMIT => inspect receipt, never replay.
5. Feed the now-reconciled owned position into unchanged strategy evaluation, current fee/book/authority checks and existing durable protective reservation/UNKNOWN-before-POST mechanism. No direct new SELL method. Entries stay held. Exact semantics for allowing protective-only execution must be explicitly approved and implemented across native gates rather than fabricated from this design.
6. An uncertain protective POST is never resent. Reconcile exact client/order identity using existing protective UNKNOWN recovery. An expired read, changed fence, existing pending reservation, KILL or changed policy invalidates the plan. Fresh receipt/book/fees do not confer fresh authority by themselves.
7. After flat settlement/exit, keep entry hold; restart is a separate supported action. No automatic strategy reentry.

## Prototype boundaries

boundedUnknownEntryRecovery.ts implements only finite read scheduling decisions: one in-flight read, three-attempt/15-second cap, clock monotonicity, fence and attempt binding, explicit stop, terminal states, and escalation. It never imports a database, transport, credential loader, dispatcher or worker. REQUEST_AUTHORIZED_READ is a request to a future trusted coordinator, not permission. read_completed means bytes arrived, not authenticated truth or successful ledger commit. It always ends in review, never in order authority. Caller events/state must be server-derived and durably stored; this is not a validation boundary for request JSON.

The 31 offline tests cover positive and adversarial scheduling behavior. They do not qualify authentication, locks, persistent restart accounting, multi-process concurrency, transport cancellation, real PostgreSQL, native full financial aggregates, fee/position correctness or live exits. No runtime import or test-command registration is added because this is an unregistered design prototype.

## Mandatory integration tests before any runtime wiring

- Two coordinators, crash/restart, lost acknowledgment, owner KILL and ARM/KILL ABA; total attempts/deadline durable across process replacement.
- Entry POST uncertain, late partial fills, duplicate fills, current/archive representation drift, terminal order absent, settlement arriving during collection and mismatched cash.
- Late read completion, cancellation that does not cancel underlying transport, and expired evidence while waiting for locks.
- Existing protective UNKNOWN, simultaneous protective dispatch and transfers, transaction connection loss and uncertain ledger commit.
- Account/policy/credential/lease changes and schema/FK drift; no persistent key creation or widened signing access.
- Native ledger idempotence and unchanged reserves/freezes on every failure; no new entry dispatch in any recovery state.
- Exact approved fee/source/book/floor checks and existing UNKNOWN-before-POST behavior; no second SELL after uncertain outcome.

## Incident-specific implication

A 15-second retry alone would not guarantee rescue: the observed paper momentum exit occurred about 26 seconds after fill, and the underlying mapping defect may persist. A successful ledger recovery must hand off to an independently authorized protection-only monitor for the remaining market lifetime. Paper 53-cent exit was not executable proof; a book 559ms later showed 36 cents. Never report this candidate as having prevented the historical loss.

## Independent review and implemented integration components

Review found existing STOP semantics suffice for a same-session entry hold. startRecovery remains unsuitable because it returns before position management. Process loss permanently abandons automatic recovery; owned lease startup refusal is retained. No restart-resumable budget is claimed.

unknownEntryRecoveryHold.ts is an unregistered worker-scoped transaction candidate. It snapshots scalar input, locks account then exact holder/token lease, binds fingerprint and all financial/provider/vault IDs, locks policy/credential/financial/provider rows, requires exact UNKNOWN dispatched BUY/IOC, and only sets arm_requested=false. Failed COMMIT is uncertain and never retried. Cleanup failure does not erase a committed outcome. It uses clock_timestamp() for heartbeat freshness. It is not a source of financial or read authority.

boundedUnknownEntryReadRunner.ts is an unregistered one-use GET-collector coordinator. It authorizes each read, caps attempts at three and wall deadline at 15 seconds, rejects regressing clocks, and abandons the instance on timeout. Even an abort-ignoring collector can never overlap with a retry. read_completed still requires native ledger validation. Current retry runner does not impose backoff; the separate pure scheduling prototype shows a one-second policy. Integrators must choose one consistent policy, not combine them as if already connected.

Independent review identified critical missing ledger integration: use opt-in trusted held-context hooks after account lock and immediately before COMMIT, validating current lease/policy/credential state and fresh deadline while locks are held. The existing ledger catch calls freeze in a new transaction; held-fence failures and uncertain held COMMIT must NOT fall through to that unfenced write. Preserve ordinary callers unchanged. Suppress afterReconcile throughout the held session, including protective-outcome callbacks. No such ledger change has been made yet.

Validation completed: 31/31 Node unit tests and standalone strict TypeScript checks for all three runtime candidates. SQL tests use a fake client; no native database/concurrency or full repository aggregate has run. Initial test harness matched COMMIT inside READ COMMITTED, causing one false harness failure; exact COMMIT matching fixed the test, not runtime semantics. Code remains unregistered; these are reviewed building blocks, not a completed live fix.

## Final local qualification boundary

Independent follow-up review found and fixed a deadline gap immediately after asynchronous read authorization, mutable dependency references, and a native-test wait that could hide an early refusal. The runner now copies dependencies and validates a fresh monotonic clock just before transport. 31/31 final bundled offline tests pass. Strict TypeScript checks include all three candidates, their unit tests and the native PostgreSQL test source.

Native PostgreSQL execution did not run: the first attempt failed to resolve pg during bundling (fixed nodePaths); subsequent normal and supported permission-escalated attempts initialized fresh PG17 clusters but could not create their Unix sockets (Operation not permitted). No fallback to TCP, remote databases or production was attempted. Test driver uses a fresh Unix-socket-only cluster, credential-stripped child environment and network fence. It is an executor-specific local test harness with absolute existing-tool paths, not a portable production script.

Retained failed-start directories are /tmp/strata-analytics-pg-hBgraQ and /tmp/strata-analytics-pg-mJpYxk. Subsequent read-only pg_ctl status reported no server running for each, PID files absent, logs state shut down. Directories are retained because lifecycle helper conservatively classified failed startup as uncertain. No claim of native test qualification or end-to-end resolution is made.

## Integrated candidate checkpoint (default off)

The candidate now contains same-session runtime wiring guarded by STRATA_UNKNOWN_ENTRY_PROTECTIVE_RECOVERY_ENABLED=true. Default is off. The original worker's exact history-unreconciled failure may select only one UNKNOWN entry with successful POST_ATTEMPT evidence, close entries before awaits, commit exact-worker STOP, and perform a single bounded read recovery episode. Process loss never restores this mode automatically.

Every held-session reconciliation now uses native reconcileHeld with fresh same-transaction account/lease/policy/credential/global gates, independent financial-row locks and FK validation, and final heartbeat/deadline/liveness checks. Existing freezes are retained and every newly detected financial risk rejects the held transaction rather than hiding behind an existing reason. Uncertain COMMIT emits no successful receipt and is never replayed. Renewal callbacks remain suppressed for the entire held session. Ordinary position evaluation and existing protective reservation/UNKNOWN-before-POST/dispatch stay unchanged. Any later held-session error stops scheduling.

The read deadline now reaches signed GETs through an optional AbortSignal on the original transport (quota identity unchanged); KILL aborts it, and per-feed checks stop subsequent requests. The 15-second budget governs acceptance and cancellation, not guaranteed immediate completion of blocked pool/SQL operations. Results that arrive after the deadline never authorize financial work. No promise of guaranteed liquidation or prevention of all future losses is made.

Current integrated offline runner: 149/149 passed, with no socket/fetch allowed except explicitly injected fakes. Full API typecheck passed before the latest native test addition; a final pass remains required. New native full-schema held-ledger test covers exact open-position accounting, competing authority writers, timeouts, risk preservation and lost COMMIT acknowledgment. Native suites remain unexecuted locally because socket access was denied; portable GitHub draft CI is the next qualification step.

Independent source follow-up found no further clear authority-expansion or duplicate-order defect after corrections, but requires native schema/concurrency qualification and full protective-outcome integration (partial fill, durable no-send, UNKNOWN and PREPARED paths) before enablement. The five-second heartbeat guard may fail closed on slow reads; this limits usefulness rather than granting stale authority. No deployment or flag change is authorized by these test results.
