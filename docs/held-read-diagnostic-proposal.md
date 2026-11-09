# Held read diagnostic candidate

Status: unregistered server-only candidate, not deployed or activation-qualified.
No route, UI, credential creation, permission grant, order path, ledger write,
worker callback, approval, ARM or START is added.

## Implemented

The signed GET client accepts optional server-only diagnostic instrumentation.
It validates a fixed production-origin seven-feed allowlist, subaccount 1/index 2,
page limit and opaque cursor shape before signing. Original fetch identity,
durable balance quota, and shared cooldown remain unchanged. Production harness
construction refuses injected transport wrappers. Existing non-diagnostic reads
retain their parsing behavior.

The diagnostic uses existing backend database access and server-authenticated
owner identity. An explicit READ COMMITTED READ ONLY transaction verifies one
commissioned killed/off account, zero reserved funds/open positions/nonterminal
intents/protective reservations, killed non-ARM worker, approved exact policy,
verified nonrevoked restricted-execution credential, matching worker and account
fingerprints, and financial/provider/vault bindings. Actual loaded signer
fingerprint must match. Every request rechecks scope before and after quota wait.
It also checks the real backend session replication role is origin.

A process-wide owner guard plus transaction advisory lock excludes other
cooperating diagnostics, including recreated factories. The transaction/guard
remain held while asynchronous work is undrained. Each factory is one-use.
No financial account identifiers, balances, provider response bodies or secrets
are returned; only status, aggregate timing, known request count and DB role.

Budget is at most 15 seconds, then at most one second to await drain. An ignored
abort reports drained:false and cannot retry through that factory/process owner.
Each JSON response is at most 1MiB and aggregate scan input at most 8MiB. Error
bodies are cancelled before settlement; failed cancellation remains explicitly
undrained. Timers cannot guarantee elapsed bounds during blocked event loops.

## Qualification

192/192 offline tests passed, including 15 diagnostic cases plus 177 affected
recovery regressions. New coverage includes complete seven feeds, malformed or
foreign scope, repeated/opaque pagination, missing archives, cooperative and
ignored abort, recreated factory exclusion, error-body drain, oversize refusal,
shared 429 cooldown, and the original production quota admission path. Synthetic
RSA and injected transports only; deny-all real socket/fetch fence was active.
No provider or production database request occurred during development.

Independent static review identified four defects in the prior iteration:
transport-wrapper quota bypass, inherited transaction isolation, undrained error
bodies, and unbounded JSON. These were fixed with regression tests. A final
review of those changes remains pending.

## Remaining gates

- Add reviewed authenticated registration using trusted JWT owner, never body
  owner/account selectors. This candidate is deliberately not a callable route.
- Run native PostgreSQL schema/role/FK, concurrent owner/fence/revocation,
  advisory-lock and rollback tests. Current scope tests mock database responses.
- Verify actual successful durable quota behavior, exact deployed provenance,
  signed-feed latency and abort/drain on the target backend without orders.
- Balance quota reservation writes existing quota bookkeeping through its global
  pool. The scope transaction is read-only; the entire diagnostic is not strictly
  zero-write. This is necessary to preserve normal quota safety.
- The lock excludes cooperating diagnostics, not execution or credential writers.
  Rechecks are not an atomic freeze through network completion. No diagnostic
  response grants trading authority. DB connection loss can release the advisory
  lock before an uncooperative transport drains; process exclusion remains local.
- Feed imports still load existing database infrastructure. No claim of a pure
  database-free import is made. Undrained work may require operator process
  recovery; do not automatically clear its guard or retry.


## Follow-up qualification candidate

Added an unmounted Express router factory with existing trusted authentication
middleware first. The handler accepts only res.locals.strata.subject, rejects all
body/query selectors, sets no-store, and propagates request/response disconnect.
It is not mounted in the application and creates no production endpoint yet.

Database error/end events now cancel in-flight diagnostic work and invalidate its
scope. The connection is discarded without reusing a lost session. Pending work
still owns the local single-flight guard until settlement; server lock loss is
reported, not treated as a completed read.

197/197 offline tests pass after these changes. The native Unix-only disposable
suite was authored and bundled, covering role, read-committed visibility,
concurrent revocation/fence/ARM/policy changes, advisory-lock exclusion/release,
missing vault privilege, backend termination, and actual local quota writes plus
saturation refusal. It uses a minimal mechanics fixture, not the complete
production migration chain; production-schema qualification remains separate.

Execution blocked before tests: PostgreSQL 16 could not create the fresh owned
Unix socket (Operation not permitted). No alternate transport or retry was used.
The runner retained its owned cluster directory after uncertain-start cleanup;
a read-only pg_ctl status check confirmed no server running and no PID file.
No native assertion has been counted as passed. Run the committed dedicated
package entrypoint on an authorized CI host with local PostgreSQL available.

Final independent review of this follow-up remains required before integration.
