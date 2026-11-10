# Combined restricted-worker qualification

This is a disposable **trusted-worker compatibility experiment**, not a production role migration, tenant boundary or trading approval. No runtime modules, production migrations or canonical runner are changed.

Run `pnpm --filter @workspace/api-server run test:restricted-combined-worker`. The unchanged canonical runner creates a fresh loopback-only database for each native file and denies external sockets. It has no connected-database fallback. No production secrets, rows, HTTP or grants are used. The supervisor's real signing path uses only a freshly generated ephemeral fixture key and a synthetic transport.

## Finite scope

Seven existing restart outcomes are reused, with their original assertions and the owner-baseline suite retained: zero/partial/full protective fill recovery once; missing exact position; lost protective reconciliation COMMIT acknowledgment; markerless expired PREPARED exit; PREPARED reservation remaining blocked.

Two combined supervisor runs add:

1. Real flat reconciliation renews the continuous technical lease and audit; an expired original fee grant forces actual standing fee renewal. The acknowledged UNKNOWN entry then drives real held partial-to-flat protective exits using native standing-successor SQL.
2. After preliminary successor authorization, a deterministic synthetic provider-read boundary commits independent technical-review revocation. The native final successor query refuses, no POST occurs, the reservation remains UNKNOWN, the scheduler stops, and financial balances/positions do not continue. Control bookkeeping such as revision/uncertainty recording is not confused with a financial fill.

Held mode deliberately skips continuous entry-lease renewal. The test snapshots technical rows after the normal flat phase and requires no changes during held protection. Owner continuous-entry consent revocation alone is not equivalent to independent technical-review revocation and is not used to remove reduce-only protection.

## Combined permissions

The protective manifest is extended with explicit Auth/profile/model row locks, standing delegation `UPDATE(lease_expires_at)`, and exact continuous technical lease/audit columns. Existing operational account/worker-lease UPDATE privileges already permit locks. These three mutable tables never receive incompatible blanket `WITH CHECK(false)` policies from the standalone fixtures.

Pure read-only human/platform tables retain restrictive mutation denial, including under an additional permissive policy. The genuine nonowner login cannot reset into an owner role, create human approvals or rewrite human scope. Setup mutations are on a separate fenced pool. The original privileged singleton is closed and both query/connect defaults route to the restricted login.

Auth/profile owners and browser policy shapes are synthetic catalog-shaped fixtures from the previous qualification. Auth helpers/MFA dependencies are not managed authentication implementations. The Vault contract here is a dummy table; native Vault cryptography is a separate qualification, not silently implied by these scenarios.

## Limits and remaining cutover work

- Database constraints alone do not authenticate provider observations. Fee lease expiry is bounded by human valid_until; continuous expiry is relative to worker-writable observed_at. The application checks current proof, scope and revocations. This remains a trusted evidence-writing worker.
- The worker cannot INSERT ENTRY intents. Ordinary trading, withdrawals, legacy/background workers and complete API operation are outside this package.
- Killed-account owner recovery keeps its separate role/policies. Do not combine its killed/disarmed predicate with ordinary worker writes.
- Current production API and worker share one pool and in-memory scheduler. Replacing that global credential with this role would break authorized approval/revocation writes. A true worker-versus-human-authority boundary needs separate process/secret access and an explicit, authenticated control/status seam preserving one scheduler. Two pools in one process are only routing discipline.
- Actual deployment pool routing, managed platform integration, session-lock compatibility, exact production privileges and rollback remain cutover gates. This package creates none of that authority.

## Validation status

Local validation passed 7 new contracts and 33 prior restricted-runtime contracts, including parsing all changed TypeScript, capability classification and transparent observer behavior. Independent static review covers the complete candidate; the original baseline's 21 subtests and 55 assertion lines were retained during extraction.

Local native execution is unavailable because PostgreSQL binaries are absent; the canonical runner stops before database creation. A typecheck attempt using the existing compiler stopped at TS2688 because this clean worktree lacks Node type definitions. This is not a semantic typecheck pass. Build was not run. Full workspace typecheck/build and all nine database outcomes require the hosted qualification path before any native success claim. Record the actual database version from logs, not a CI matrix label.
