# Bounded recovery after an acknowledged, unreconciled entry

Status: integrated, default-off candidate based on backend commit 29239e42fcdb1bf5b0223b0ae421b0cfea5705b5. Not deployable or trading-authorized until native qualification and remaining protective-lifecycle checks pass. Sections below retain initial design boundaries; the integrated checkpoint at the end describes current implementation.

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

The 31 offline tests cover positive and adversarial scheduling behavior. They do not qualify authentication, locks, persistent restart accounting, multi-process concurrency, transport cancellation, real PostgreSQL, native full financial aggregates, fee/position correctness or live exits. This paragraph describes the initial unregistered prototype. The later integrated checkpoint registers tests and adds default-off runtime wiring.

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

Independent review identified critical missing ledger integration: use opt-in trusted held-context hooks after account lock and immediately before COMMIT, validating current lease/policy/credential state and fresh deadline while locks are held. The existing ledger catch calls freeze in a new transaction; held-fence failures and uncertain held COMMIT must NOT fall through to that unfenced write. Preserve ordinary callers unchanged. Suppress afterReconcile throughout the held session, including protective-outcome callbacks. At that initial checkpoint no ledger change had been made; the later integrated checkpoint includes it.

Validation completed: 31/31 Node unit tests and standalone strict TypeScript checks for all three runtime candidates. SQL tests use a fake client; no native database/concurrency or full repository aggregate has run. Initial test harness matched COMMIT inside READ COMMITTED, causing one false harness failure; exact COMMIT matching fixed the test, not runtime semantics. That checkpoint covered unregistered building blocks. Current default-off integration is described below; it is still not a completed live fix.

## Historical local qualification boundary

Independent follow-up review found and fixed a deadline gap immediately after asynchronous read authorization, mutable dependency references, and a native-test wait that could hide an early refusal. The runner now copies dependencies and validates a fresh monotonic clock just before transport. 31/31 final bundled offline tests pass. Strict TypeScript checks include all three candidates, their unit tests and the native PostgreSQL test source.

At that local checkpoint, native PostgreSQL execution did not run: the first attempt failed to resolve pg during bundling (fixed nodePaths); subsequent normal and supported permission-escalated attempts initialized fresh PG17 clusters but could not create their Unix sockets (Operation not permitted). No fallback to TCP, remote databases or production was attempted. Test driver uses a fresh Unix-socket-only cluster, credential-stripped child environment and network fence. It is an executor-specific local test harness with absolute existing-tool paths, not a portable production script.

Retained failed-start directories are /tmp/strata-analytics-pg-hBgraQ and /tmp/strata-analytics-pg-mJpYxk. Subsequent read-only pg_ctl status reported no server running for each, PID files absent, logs state shut down. Directories are retained because lifecycle helper conservatively classified failed startup as uncertain. No claim of native test qualification or end-to-end resolution is made.

## Integrated candidate checkpoint (default off)

The candidate now contains same-session runtime wiring guarded by STRATA_UNKNOWN_ENTRY_PROTECTIVE_RECOVERY_ENABLED=true. Default is off. The original worker's exact history-unreconciled failure may select only one UNKNOWN entry with successful POST_ATTEMPT evidence, close entries before awaits, commit exact-worker STOP, and perform a single bounded read recovery episode. Process loss never restores this mode automatically.

Every held-session reconciliation now uses native reconcileHeld with fresh same-transaction account/lease/policy/credential/global gates, independent financial-row locks and FK validation, and final heartbeat/deadline/liveness checks. Existing freezes are retained and every newly detected financial risk rejects the held transaction rather than hiding behind an existing reason. Uncertain COMMIT emits no successful receipt and is never replayed. Renewal callbacks remain suppressed for the entire held session. Ordinary position evaluation and existing protective reservation/UNKNOWN-before-POST/dispatch stay unchanged. Any later held-session error stops scheduling.

The read deadline now reaches signed GETs through an optional AbortSignal on the original transport (quota identity unchanged); KILL aborts it, and per-feed checks stop subsequent requests. The 15-second budget governs acceptance and cancellation, not guaranteed immediate completion of blocked pool/SQL operations. Results that arrive after the deadline never authorize financial work. No promise of guaranteed liquidation or prevention of all future losses is made.

Current integrated offline runner: 149/149 passed, with no socket/fetch allowed except explicitly injected fakes. Full repository typecheck and API build passed on GitHub CI for candidate commit 6848a75d11f56048086c0fd974984107c935b21c. Native suites could not execute locally because socket access was denied; authorized GitHub CI executed both against disposable PostgreSQL 16. Native hold tests passed 10/10, including competing authority writers and lost COMMIT acknowledgment. Full migrated-schema held-ledger tests passed 15/15, including real financial writes, rollback, independent-transfer refusal, lock timeout, risk preservation and lost COMMIT acknowledgment. Counts include each suite's parent test. Protective lifecycle extensions remain under qualification.

Independent source follow-up found no further clear authority-expansion or duplicate-order defect after corrections, but requires native schema/concurrency qualification and full protective-outcome integration (partial fill, durable no-send, UNKNOWN and PREPARED paths) before enablement. The five-second heartbeat guard may fail closed on slow reads; this limits usefulness rather than granting stale authority. No deployment or flag change is authorized by these test results.

## Draft publication and native CI

After an initial publication authorization denial, exact user instructions were supplied and the permitted retry succeeded. Draft PR #312 targets main: https://github.com/PatentFiles/Strata-Backend/pull/312. Its initial remote commit 6848a75d11f56048086c0fd974984107c935b21c matches the local candidate tree 16b34416b9a07b2c082ecb5d91d299d6ef2bee86 exactly.

The acknowledged-entry recovery workflow passed: https://github.com/PatentFiles/Strata-Backend/actions/runs/42628921413. This qualifies the tests present at that commit, not subsequent edits or live operation. No merge, deployment, production configuration change, real exchange request or actual order was made by this qualification work. Recovery remains off by default until the remaining lifecycle and integration review is complete.

## Protective preparation follow-up

Independent review found ordinary market preparation could invoke ORDER_ENTRY fee observation renewal even though afterReconcile was suppressed. Held sessions now use the existing read-only reviewed protective fee verifier, checking exact market/digest and provider freshness with approved API policy/formula. There is no fallback to entry verification. Unsupported source models fail closed. Native preparation and final dispatch retain their independent policy/source and authority checks. Local regression count is now 157/157, and strict API TypeScript passes.

Seven additional native lifecycle tests cover zero/partial/full SELL evidence, idempotence, incomplete evidence, lost acknowledgment and PREPARED handling. They sequence existing recovery components with synthetic evidence and seeded reservation rows, not a complete supervisor-to-dispatch integration. Their native execution awaits the next CI run. A source-extraction regression now terminates at the actual end of the prefetch hook rather than accidentally including the newly adjacent recovery block; all four original assertions pass.

## Lifecycle CI and scheduler checkpoint

Commit fa6ab2e866923632844f7b24114d83d41d504671 passed recovery CI with 157 offline tests, 10 native hold tests, 22 full-schema/lifecycle tests and typecheck/build. Source: https://github.com/PatentFiles/Strata-Backend/actions/runs/42630320411. Selected output is preserved in held-recovery-lifecycle-ci-evidence.log.

The next test-only checkpoint has 171 passing offline tests. Real scheduler/executor/ledger-body/outcome-handler tests cover no renewal or entry discovery and actual timer stop after ambiguous outcomes. These use a flat, closed-world SQL fixture and directly installed held hooks, not native scope fences or supervisor activation. The synthetic RECONCILED outcome demonstrates handler routing, not authenticated acknowledgment verification. Separate native tests cover scope fences and authenticated outcome component sequencing.

Feature-off regressions execute the actual supervisor-installed recovery callback with absent and non-true flags, proving it returns before dependency access or state mutation. Ordinary afterReconcile renewal, ordinary ledger freeze behavior and ordinary unrelated-error polling remain covered. Actual protective verifier composition is tested against mocked SQL/provider boundaries with no observation lease reads/writes, not a claim of real expired-grant SQL selection.

Remaining activation qualification: production supervisor through strategy, native preparation/reservation and actual signed dispatch against disposable approval fixtures with only external HTTP/credential I/O replaced; genuine durable no-send creation; subsequent strategy-selected exit after partial fill; representative heartbeat/latency/cancellation and current release/configuration checks. Default-off merge review must not be described as activation readiness or a completed live fix.

## Digest-domain correction

Full supervisor fixture preparation found the commissioned artifact and protective rate-model proof use different digest domains. ownerApiFeePolicyMigration persists apiFeeSourceStage.identity.digest, a historical reviewCandidateDigest that binds observation metadata. reviewedProtectiveExitFee returns the fixed independently reviewed rate-model digest. Comparing those hashes incorrectly refused migrated API accounts.

Held market preparation now validates the protective proof against PDF_FREE_API_RATE_REVIEW_DECISION_SHA256 and preserves the original account artifact in market evidence. It validates the artifact's hash shape; it does not claim to authenticate that historical artifact itself. Locked native policy/source/formula and final protective authority checks remain unchanged. Both helper and actual-verifier composition tests explicitly use distinct artifact/model hashes; wrong model digest still rejects. All 171 offline tests and configured API typecheck pass locally after correction. New-head CI remains required.

## Full supervisor fixture authored, pending native execution

A new disposable native test drives createProductionPersonalSession with production startup validation, unmodified strategy/preparation/reservation/signed dispatcher, generated ephemeral Vault credential data and strict synthetic fixed-host HTTP responses. It seeds only the already acknowledged ENTRY after healthy START; every EXIT must come from production code. Scenarios target partial fill followed by a second owned exit, actual durable no-send, and ambiguous POST stopping without retransmission. RSA signatures and durable UNKNOWN-before-POST are asserted at the fake HTTP boundary. This is authored test coverage, not a passing result until CI executes it. No production credentials, account, network request or order are used.

Fixture review strengthened scenario isolation before execution: each scenario now has its own wrapper, Node process and fresh disposable database. Cleanup always stops the source timer, attempts worker KILL and ends the pool; the synthetic fetch fence remains installed until process exit. The existing runner bounds each child to 180 seconds and stops its cluster on failure. Successful partial/no-send continuation requires terminal evidence plus a subsequent held receipt and later serialized tick evidence, not merely an inserted marker.

## Consistent production-owned read destination

Native supervisor qualification reached real EXIT preparation and then exposed a shared default-host mismatch: independent protective reads used the generic client's demo fallback while supervisor reads explicitly used production. The default personal-owned reader now pins PERSONAL_KALSHI_HOST, preserving the original fetch identity, quota-owner and AbortSignal arguments. Explicit injected sandbox readers and generic-client demo behavior are unchanged. This hardening applies outside the recovery flag and requires broad regression qualification. Host tests cover absent/demo/production configuration and explicit injection; the full native fixture deliberately sets generic demo configuration while its synthetic transport accepts production only. A production configuration check reported KALSHI_API_ENVIRONMENT=production, so the source mismatch is not evidence that the running service was misconfigured.

Scoped-host checkpoint: 177 offline tests pass, including a functional production-quota owner validation before transport (not a database budget test). Configured API typecheck passes. Independent review found no source-level publication blocker; exact-head CI is still required for the shared-reader change.
