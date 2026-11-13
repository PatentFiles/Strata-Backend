# Owner transient database freeze recovery

This is accounting recovery, **not START, ARM, review, fee approval, or execution consent**.

The existing worker rejects every `blocked_reason` before signed reconciliation;
ordinary reconciliation intentionally retains that hold. Stale-lease recovery only
fences a dead worker, and commissioning repair only clears its provisional marker.
Neither is an appropriate way to remove a database connection timeout hold.

## Explicit owner action

After deployment, an authenticated AAL2 owner may POST
`/api/strata/production/protective-release/owner-transient-freeze-recover` with:

```json
{"confirmation":"I_AUTHORIZE_SIGNED_TRANSIENT_DATABASE_FREEZE_RECOVERY_AND_KEEP_MY_ACCOUNT_DISARMED"}
```

The router derives the owner from authenticated middleware, not the request body.
The only eligible reason is exactly `timeout exceeded when trying to connect`.
The status field `transientDatabaseFreezeDetected` is owner-only discovery, not
proof that recovery will pass. There are no automatic retries or SQL clearances.

Required evidence: released/disarmed worker, exact owner/account/pair, current
approved policy/hash, locked current restricted credential and verified signer,
no nonterminal/UNKNOWN/PREPARED financial intent or protective reservation, zero
local and exchange exposure, complete current **and archival** authenticated
orders/fills/positions/settlements, exact ledger event/cash parity and conservation.
The signed snapshot must remain within five seconds, including the final database
clock check after the audit insert. Unavailable history is UNKNOWN, never empty.

Account and worker locks serialize final admission, while policy and credential
locks prevent revocation drift. The initial account lock is bounded to 1.2 seconds.
On success, a durable audit and revision-CAS clear only the timeout and refresh
reconciliation; account `execution_enabled=false`, `kill_switch=true`. The worker
lease stays released/disarmed. No grant, approval, technical lease or review is
created, renewed or revoked. Ordinary qualification, genuine independent review,
fee consent and separate explicit owner authorization remain necessary afterward.

A lost COMMIT acknowledgement returns `recovery_commit_outcome_unverified`,
`outcomeUnknown=true`, `riskFreezeCleared=null`: inspect current status, do not
assume rollback or retry automatically. Other failures retain the hold and return
no clearance; incomplete late accounting needs its independent recovery workflow.

## Verification

- 27 mocked adversarial tests (owner mismatch, wrong reason, UNKNOWN, positions,
  revoked policy/credential, stale/incomplete proof, races, audit/CAS failure and
  ambiguous COMMIT).
- 7 real PostgreSQL tests in a fresh isolated, credential-stripped, outbound-fenced
  cluster: success/replay, concurrent START-style account lock, bounded initial
  lock, lease serialization, credential revocation, actual delayed-audit expiry
  rollback. These are schema-minimal transaction tests, not a production migration.
- Run the TypeScript unit test with the existing esbuild test pattern and run:
  `node scripts/run-v13-disposable-postgres.mjs --recovery` from API server.

No production invocation or exchange mutation was performed during implementation.
