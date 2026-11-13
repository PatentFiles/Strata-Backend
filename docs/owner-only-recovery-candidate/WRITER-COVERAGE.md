# Writer coverage: measured source inventory, not production qualification

The AST audit now resolves local SQL constants, recognizes quoted UPDATE/INSERT/
DELETE/TRUNCATE/MERGE targets, records ORM/computed-target and stored-routine
uncertainty, ignores commented-out calls and ordinary Map/Set deletes, and hashes
all API-server/workspace-library source, migrations, build files and lock inputs.
It does not silently label a missing static match as immutable storage.

Run from repository root:

```
node artifacts/api-server/scripts/audit-owner-recovery-writers.cjs . > writer-source-pins.json
node --test artifacts/api-server/scripts/audit-owner-recovery-writers.test.cjs
```

The reviewed local pass identified 135 runtime protected-table SQL write sites.
384 runtime call sites remain conservatively unresolved (including generic SQL
wrappers and ORM calls). These are **not 384 proven defects**. A qualified
relation-level barrier can cover dynamic writers as well as literal SQL. The JSON
contains exact source hashes, locations and the reason each site remains unknown;
its digest is reproducible for the same scanned inputs. It always reports
`completeWriterCoverage:false` and `productionQualified:false` because local source
alone cannot establish external privileges, deployed catalog, or loaded code.

## Concrete omissions repaired in the candidate

- Ledger events now share the enrolled account revision barrier.
- Control-head writes and credential-operation attempts share that same barrier.
- Observation writes take the same account lock without incrementing the financial
  revision they attest. Incrementing on receipt INSERT would invalidate its own
  persisted revision; production recovery now also rechecks owner activation under
  the held account lock.
- Seven ledger/operation/control TRUNCATE paths explicitly refuse while enrolled.
- The read-only permission probe includes ledger/audit, operation, control-head,
  consent, authority, receipt, and auth-session/user relations; it detects runtime
  authority INSERT rights and auth-schema CREATE rights.

Native tests use simultaneous independent PostgreSQL clients: event, observation,
control-head and credential-attempt mutations time out behind the account lock;
all four attempted writes roll back. Atomic disarmed recovery remains functional.
The expanded probe also reports missing relations and privileged role access in
an intentionally incomplete disposable schema, rather than claiming it healthy.

## Remaining real qualification inputs

1. Actual installed catalog digests for the complete selected relation/trigger/
   function set, compared with qualified full migration output, not adopted from
   whatever a live database happens to return.
2. Actual runtime and reachable-role privileges, including DDL/trigger-disable,
   SECURITY DEFINER, Supabase Vault/extension and external administration paths.
3. Authentic deployment/process byte identity covering externalized modules and
   worker bundles, not merely a supplied commit environment variable.
4. Protected source/policy/workflow/artifact trust pins and enrolled-account scope.

No production pins or account enrollment were manufactured. The supplemental SQL
is inactive and is not part of automatic startup/migration application. There is
no independent-human-review requirement in this candidate path.
