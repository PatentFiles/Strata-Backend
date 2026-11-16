# Owner-only final protective release candidate

Local implementation against main `70058288cf876165b602c405e40f32e47195e17a`. Not deployed or applied to production. Migration is deliberately outside automatic manifests pending integrated deployment review.

## Contract and safety boundary

POST `/owner-final-authorize` under the existing protective-release router and real Supabase AAL2 middleware. Exact body keys: `expectedSha`, `accountId`, `policyHash`, `qualificationId`, `reviewId`, `confirmation`. Confirmation is `I_AUTHORIZE_MY_ACCOUNT_FINAL_RELEASE_AFTER_SIGNED_QUALIFICATION_V1`.

Requires `STRATA_OWNER_FINAL_RELEASE_ENABLED=true` (default off), configured exact owner/account scope, current owner standing review and qualification, durable exact-SHA owner consent, killed/disarmed account, no unresolved exposure, actual full-history signed provider reads, existing fee policy checks, and locked unchanged scope. Creates explicit `OWNER_SELF_V1` protective authority with NULL independent reviewer. Does not fabricate independent review. Existing independent fee authority remains unchanged.

The transaction releases only this account and fences its stopped lease. It **does not ARM, START, submit orders, repair a provisional freeze, or enable disabled global execution**. Disabled global execution returns `owner_final_shared_global_release_requires_separate_authority`. Cash reconciliation remains separate. It is not by itself proof of overall live readiness.

A well-shaped preflight refusal before any transaction client is acquired returns `outcome: PROVEN_NOT_COMMITTED` and exact `requestScope` (the five scope keys excluding confirmation). This proves only this invocation did not enter a write transaction. It must not authorize replay: the UI may resolve that old pending attempt only on an exact match, then require a new explicit owner review. Transaction-stage failures remain unproven; unknown COMMIT remains UNKNOWN and previous recorded review remains LOOKUP_ONLY.

GET `/owner-final-outcome?reviewId=...&accountId=...` is authenticated-owner scoped. An unknown COMMIT must use this receipt lookup, not automatic retry. RECORDED reports `currentReadinessVerified:false` and is not permission to START.

The status field `ownerFinalReleaseEnabled` describes owner/account/feature availability, not readiness. Owner mode requires current review authority at startup/readiness/final-send consumers. Its history prevents fallback to legacy authority for the same SHA/owner/account after revocation. Other accounts retain legacy behavior. Independent legacy records retain their reviewer segregation and PR URL constraint.

## Database candidate

`002_owner_final_authority.sql` adds disjoint authority identities, exact commit URL constraint for owner mode, immutable account/policy/review/qualification binding, insert-time locked checks, and mode/account-scoped overlap fencing. It preserves RLS and existing immutability/COMMIT deadlines. Do not apply independently of consumer code or before runtime-role permission review.

## Evidence

Verified locally: 153/153 unit/router/startup regression entries, 11/11 native PostgreSQL entries, and full workspace TypeScript typecheck passed. Native tests use actual PostgreSQL 17.12, not an in-memory database.

- Native PostgreSQL 17.12: actual migration chain and actual finalizer with synthetic RSA-signed provider fixture. Covers transaction success, concurrent duplicate finalization with a single release/fence, owner/account/review-isolated replay receipt, rollback after account write, standing review/credential/policy/owner-consent races during signed read, deferred five-second COMMIT expiry, and lost COMMIT acknowledgment. No provider mutation or real account data.
- Independent reviewer separately tested schema coexistence across legacy and two owner accounts, overlap rejection, immutable authority/account, deletion rejection, revoked review refusal, no legacy downgrade, and concurrent review-update locking.
- Unit regression suite covers existing independent mode and explicit owner mode, policy/account/SHA mismatches, injection rejection, stopped-account/global gate, monetary fee wiring, final admission and readiness. Route tests use real signed JWT/AAL2 middleware. Startup tests explicitly use Railway/production environment.

Run native checks using `PG_BIN=/trusted/postgresql/bin PG_SHARE=/trusted/postgresql/share bash docs/owner-final-release-candidate/run-native-tests.sh`. Uses only a fresh local synthetic database on 127.0.0.1:55480, refuses other database destinations, stops its cluster on exit. No Vault extension: synthetic vault relation fixture only.

## Remaining deployment checks

Rebase/review against latest main and coordinate with Brit; integrate frontend; confirm actual production PostgreSQL version and restricted runtime-role SELECT/lock/INSERT permissions (runtime session diagnostic now reports standing review table ACL plus release_id UPDATE column ACL; this does not prove RLS visibility); apply ordered migration with rollback plan and feature off; validate exact deployed SHA and current gate state read-only; do not alter fee independence or authorize trading from receipt alone. Deployment and production owner action must be coordinated separately.

## Automated candidate coverage

The dedicated `.github/workflows/owner-final-release.yml` runs on affected pull requests with read-only repository permissions. It runs workspace typecheck, the explicit owner authority/AAL2 route regression package command, and disposable native PostgreSQL finalizer tests. CI uses PostgreSQL 16. Local native validation passed separately on PostgreSQL 16.15 and 17.12; remote exact-SHA CI has not run. No production secrets or deployment steps are present.

Local commands added and verified November 16: `test:owner-final-release-unit` (including final signed admission and session-route regressions) and `test:owner-final-release-postgres` (11 tests with trusted PG_BIN/PG_SHARE). Remote exact-SHA CI remains required.

Audit hardening: the native schema guard now requires the exact qualification referenced by the standing review, rather than merely another fresh qualification in the same scope. The added negative insertion test passes on PostgreSQL 16.15 and 17.12. The runtime-session route fixture now includes and asserts the standing-review locking-column capability and ninth relation, preserving fail-closed parsing.

Additional audit evidence: exact-source analytics native tests passed 8/8 on the connected Mac with their Unix-socket-only isolation fence unchanged. The cloud aggregate stopped at that environment restriction; later suites and the Mac analytics suite passed in separate runs. This is not a claim that the entire aggregate passed in one invocation. See `AUDIT-20261116.md`.
