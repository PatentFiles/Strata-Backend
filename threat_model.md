# Strata threat model

## Scope and assets

Strata is no longer a browser-only paper dashboard. The repository includes an Express API, PostgreSQL financial and audit ledgers, Supabase-authenticated owner controls, legacy Clerk routes, backend-held Kalshi credentials, and guarded live order and transfer transports. The separate TradingApp frontend is also a trust boundary and must be reviewed with its deployed backend version.

Protected assets include owner identities and roles, private signing material, financial balances and positions, order and transfer intents, fee and policy approvals, worker fencing tokens, execution releases, and immutable reconciliation evidence. Public market data is not sufficient evidence of account state or execution authority.

## Trust boundaries and controls

- **Browser to API:** Supabase JWT signature, expected issuer/audience, required expiration, UUID subject and AAL2 are checked in `src/lib/strata/supabaseAuth.ts`. Current operator roles come from `public.profiles`, not browser-supplied roles. Legacy Clerk routes have separate authorization. CORS is an origin allowlist in production, not an authentication control.
- **Owner to account:** Personal routes derive the owner from verified identity and must constrain all account queries, credentials and mutations to that owner. Operator-only routes require a current ADMIN or DEVELOPER role. Request bodies must never supply authority merely by naming an owner or account.
- **API to PostgreSQL:** The server uses privileged database access. Correct owner predicates and transaction boundaries therefore remain mandatory even when database RLS protects direct browser access. Review public-table grants, RLS policies, column privileges, and SECURITY DEFINER functions separately. Roles and credential tables must not be writable by ordinary browser clients.
- **API to Kalshi:** Credentials remain backend-held and account-bound. Signed account history, balances, positions and fees must be reconciled before entry. Public quote feeds cannot prove ownership or cash. Orders and transfers require durable one-use intent/reservation state, exact request identity and no blind retry after an uncertain response.
- **Authorization to final network send:** Policy, fee, release, owner consent, fencing, kill/stop state, loss limits and freshness must be checked at the final send boundary. Cached status, completed tests, a healthy HTTP process and paper profitability do not grant trading authority.
- **Code to production:** Release proofs are tied to deployed commit identity. Test success is evidence about that commit, not approval to merge, deploy, rearm, trade or change financial parameters.

## Principal threats and review anchors

1. **Unauthorized or cross-owner execution:** Review `strataRouter.ts`, `userExecutionRouter.ts`, `protectiveReleaseRouter.ts`, `supabaseAuth.ts`, and account-scoped database/credential code. Test missing/expired/malformed tokens, AAL1, STANDARD-role controls, foreign-owner inputs and revoked authority.
2. **Duplicate or unaccounted orders:** Review `v13-production/executor.ts`, `ledger.ts`, worker fencing, UNKNOWN recovery and protective-exit reservations. Fault-inject before/after dispatch commit and before/after HTTP send. Never infer that a timed-out POST was not executed.
3. **Financial loss beyond approved policy:** Review all-in fee calculations, stake revision, remaining loss budget, owned position quantity, reduce-only exits and minimum exit floor. A protective exit is not a guaranteed liquidation or guaranteed price.
4. **Stale or misleading evidence:** Check provider timestamps, local observation age, database reconciliation, authorization expiry, deployed SHA and frontend status contracts. Test restart and degraded-database behavior. Unavailable evidence must fail closed.
5. **Database contention and denial of service:** Paper research, dashboard scans and public market proxy requests share infrastructure with critical execution. Bound queries, concurrency, pools and network waits. Test final-fence reads for cross-connection lock cycles. Process liveness does not prove database or worker readiness.
6. **Credential or private-data disclosure:** Review logs, error responses, serializers, repository artifacts, frontend bundles and credential lifecycle. Never log keys, tokens, DSNs or raw sensitive request bodies. `sanitizePublic` is defense in depth, not a substitute for explicit response schemas.
7. **Supply-chain and release gaps:** Pin lockfiles, test the exact candidate, and include auth/control regressions in the aggregate safety suite. Check workflow path filters so changed critical modules cannot miss relevant tests.

## Known limits and verification requirements

- JWT verification checks token validity, not immediate server-side session revocation. Strict logout/revocation semantics require a separately designed current-session check; do not claim tokens are immediately invalidated by deleting a user or logging out.
- Static source review cannot attest deployed database policies, secrets configuration, frontend publication, provider latency or exchange execution behavior. Record live read-only evidence separately and timestamp it.
- Synthetic/offline protective-exit tests are not authenticated exchange proof. Launch requires current account-bound commissioning, independent review where required, owner authorization and verified recovery behavior.
- Repository audit and test execution do not authorize production changes or real-money actions. Keep changes reviewable and preserve fail-closed controls.

Paths above are relative to `artifacts/api-server/src` unless otherwise specified. Update this model whenever auth, credential, account, financial, execution or deployment boundaries change.
