# Disposable platform-shaped Vault qualification

This is a test-only candidate on merged PR324 (`16e038e0`, tree `62d405dc`). It is not a migration, production grant design, credential-creation workflow or trading authorization. No production rows, keys, secrets, extension binaries or provider requests are used.

## Observed metadata and deliberate model

Bounded read-only catalog evidence on 2026-11-10 reported `vault.decrypted_secrets` as an ordinary owner-style view (`reloptions = NULL`) owned by `supabase_admin`; its base `vault.secrets` had the same owner and RLS disabled. The dependent five-argument decrypt helper was an immutable C SECURITY INVOKER function with explicit EXECUTE ACL and no PUBLIC grant, supplied by `supabase_vault` 0.3.1. These are metadata findings, not a production function-body, decrypted-row or encryption inspection.

The disposable fixture replaces only the missing platform contract in the existing full application migration chain:

- A distinct synthetic NOLOGIN, non-superuser, NOBYPASSRLS owner owns the base table, view, helper and Vault schema. This models ownership separation, not the managed platform owner's complete role attributes or memberships.
- Existing `vault.secrets(id)` gains a dummy text column. The view projects `id` and `decrypted_secret`, the two outputs actually used by the signer loader. The other cataloged base-column dependencies are not reproduced.
- A separately named, non-inlineable PL/pgSQL SECURITY INVOKER helper has the observed five-argument type signature and returns its first dummy byte-string unchanged. Its empty search path is a fixture safeguard, not the observed production helper configuration. No encryption, key lookup, authentication tag, C-extension loading or real decrypt operation is modeled or qualified.
- The restricted LOGIN receives the two view-column reads and helper EXECUTE, schema USAGE, and SELECT for the four actual signer-query application tables. Its synthetic service-wide read policies do not authenticate users or isolate tenants. No base-table SELECT, sequence privileges, human-approval writes, role memberships or ownership are added.

## Native assertions

The real `createProductionPersonalSession` signer loader executes its unchanged SQL against this model. A wrapper observes native rows and SQLSTATE without substituting results or errors. Deliberately invalid dummy credential strings stop at parsing: every result remains `personal_signer_unavailable`, no worker is scheduled and no provider or fee callback executes. Positive coverage means the real query returned the expected dummy projection, not that a trading session started.

Cases cover genuine login identity and RESET ROLE non-escalation; catalog owner/view/helper properties; both owners' positive reads without base SELECT; wrong-owner/account, changed-fingerprint and revoked-credential exclusions; helper EXECUTE revocation (including an id-only view projection that does not evaluate the helper); independent view/schema revocations; unrelated reader denial; and denied base/view/credential/account mutations.

The suite also positively demonstrates the limitation: the service role can directly read both dummy owners through the view. A writable request-subject setting does not narrow that access, and rollback restores the local setting before the same single-connection pool is reused. Application join predicates protect that particular loader call; they are not a database-level tenant boundary or authentication proof.

## Isolation and qualification

Run only `pnpm --filter @workspace/api-server run test:restricted-platform-boundaries`, which calls the unchanged canonical disposable runner separately for Auth/profile and Vault. The existing runner creates a fresh loopback-only cluster, strips ambient credentials, fences external sockets, and removes the cluster afterward. The fixture verifies the exact canonical environment and actual database/session/host/port before DDL. Setup and runtime use different pools; the unused privileged global singleton is closed before genuine restricted logins are opened. Roles are destroyed with the isolated cluster, not by a cleanup script against a shared server.

Source-contract and TypeScript parsing checks are not native PostgreSQL qualification, full typechecking, build verification or managed Supabase parity. Native PostgreSQL execution and full workspace checks still require the authorized hosted path if local dependencies/binaries are unavailable. Production pooler mode, actual extension behavior, complete platform schema/ACL drift, per-account Vault isolation, and the real JWT verification-to-database identity boundary remain separate rollout gates. No production permission change is safe merely because this fixture passes.
