# Strata protective-exit release readiness — verification worksheet

Scope: read-only verification and release preparation. **Never interpret this document as trading authorization.**

## Verified against PR #99
- Parent candidate head at branch creation: `b8f926f1b379a082d6df9b9735a81d7262901064`.
- Two parent exact-head GitHub CI suites passed on October 19, 2026. They are regression simulations, **not** authenticated exchange validation.
- Separate disposable PostgreSQL test PR #100 covers proposed baseline, reconciliation and release-ledger migrations; confirm its own CI conclusion before marking verified.
- Connected Supabase project currently has 0 emergency-exit reservations and 0 DEMO IOC attempts. Proposed release and reconciliation tables are absent; do not apply prior to approval.
- Railway connector exposes zero accessible projects. Deployed SHA, process environment and activation flags remain unverified.

## Required release evidence and acceptance criteria
| Gate | Evidence required | Result |
| --- | --- | --- |
| Owner/identity | Authenticated owner, INDEX2, subaccount 1, account-specific signer fingerprint and leased worker identity independently rechecked | PENDING |
| Exit reserve | Unique immutable one-use client_order_id + digest, durable UNKNOWN before POST, fresh position and fee preflight, zero unresolved orders | PENDING REAL INTEGRATION |
| Crash/restart | Full authenticated paginated orders/fills/positions, lost response, pre-POST crash, concurrent fill, worker death and double-resume; no second POST | PENDING REAL INTEGRATION |
| Price | Owner-persisted minimum exit **$0.01** equals 10,000 micros; check YES ask / NO bid direction and net proceeds semantics | PENDING ACCOUNT CHECK |
| Fees | Current provider-origin official monetary schedule, market overrides, staged changes, precision and version-pinned independent review | PENDING |
| Execution limits | Stake cap, open-order constraints, loss caps, current holdings, fee budget, idempotent IOC no-retry | PENDING |
| Kill switches | Global live OFF / manual kill ON and all account kills ON until approval; verify by authenticated source before any change | PENDING FRESH CHECK |
| Privileged release | Independent APPROVED GitHub review tied to **final SHA**; segregated operator approval; private time-bounded release row | PENDING |
| Exchange evidence | Restricted DEMO environment, owner-authorized signed IOC, zero/partial/full where reproducible, lost response, fills/position reconciliation | PENDING |
| Deployment | Verify Railway project access, build/deploy SUCCESS, exact deployed git SHA vs approved commit, health and env flags | PENDING |
| Frontend | Verify same backend revision, account-specific release and global activation visibility and dashboard signals | PENDING |
| Go/no-go | Written go decision tied to all above; separate account release, global release, ARM and START | BLOCKED |

## Rollback and incident response
1. Maintain/engage global and account kill switches; do not dispatch new entries. Preserve permitted cancellations.
2. Inventory exchange-confirmed positions, fills, resting orders and UNKNOWN intents using authenticated account-scoped reads.
3. Never rerun an ambiguous IOC or reset UNKNOWN to PREPARED. Keep immutable evidence and escalate uncertain state.
4. Revoke any active time-bounded release using its supported privileged revocation operation; do not delete audit rows.
5. Revert the backend to last verified approved deployment **only after** evaluating open intents and DB forward-compatibility. Do not down-migrate financial ledgers.
6. Reconcile all exchange/DB/account balances and obtain fresh security approval before considering restart.

Do not publish any claim of completed commissioning from unit tests or from this worksheet.
