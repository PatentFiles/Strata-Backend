# Actual fee migration workflow regression

`candidate/ownerFeeMigrationGeneration.postgres.test.ts` invokes the real `migrateOwnedApiFeePolicy` and `migrateOwnedV3FeePolicy` implementations with real PostgreSQL queries and the candidate consent-generation schema/triggers.

Provider feed reads and external technical-fee verification are injected synthetic test evidence. The database adapter is real PostgreSQL, except a single explicit audit-failure injection used to prove rollback. This does not constitute real provider verification or production authority approval.

For both workflows, covered:
- Locked authority expiry rejects with exact workflow-specific reason even though external verifier stub reports success.
- Complete valid policy hash/version proof, authority/evidence SQL joins, account policy relink, old policy revocation/new policy insertion, owner-approval revocation, generation increment and audit commit.
- Injected generation audit failure rolls back policy/account/head together.
- Same workflow with no current owner approval still advances generation and succeeds.
- Account remains disabled+killed; worker stays released; cash/reserved balances unchanged.
- Old unbound qualification cannot create a new approval after migration.

Final run: PostgreSQL16 loopback only, `renewal_disposable_2026111221`;3/3 tests pass (assertion matrix nested in two workflow subtests). Log `strata-fee-migration-generation-pg.log`. Full API typecheck passes: `strata-fee-migration-generation-typecheck.log`. Disposable server stopped by shell trap.

Synthetic table schemas supply required fields but do not establish production RLS/roles, all constraints, real issuer signatures or current remote state. No production mutation, network order, deployment or policy weakening occurred.
