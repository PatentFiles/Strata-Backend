---
name: Database test context
description: Environment mismatch risk for local database-backed test runners.
---

Do not infer a shell-invoked database test or schema push's destination from `REPLIT_ENVIRONMENT` alone. A shell labeled `production` was proven by read-only database-name/server fingerprints and dev-only schema markers to connect to the **development** database, not production. Verify the actual connection against explicitly targeted development and production database read-only queries before any database-backed write; do not inspect or print credentials.

**Why:** Disposable-schema tests and schema tooling follow their ambient database connection, which need not match the shell's environment label. Refusing to run based on the label alone can misidentify a safe development connection; trusting the label alone can also misdirect a write. An earlier safety review incorrectly inferred a production database from the label without checking the connected database itself.

**How to apply:** Compare read-only database fingerprints from explicitly development- and production-targeted interfaces with the shell's actual connected database. A pinned test preflight should fail closed on production, changed, or unknown destinations **before** any schema create, test child, or cleanup DROP; do not override the guard. If the verified target is development despite a misleading environment label, the guard can proceed without changing that label. After testing, verify no disposable schemas remain and production application schema/config are unchanged. If a target cannot be established, report the exact configuration/access gap instead of guessing.

Read-only readiness reporting must likewise separate fingerprint-proven database destination from application mode inferred from `NODE_ENV`.

**Why:** A missing `NODE_ENV` can leave application mode unknown while the connected database is independently proven development. Changing runtime settings merely to improve a diagnostic verdict would hide real account-binding and commissioning blockers.

**How to apply:** Report both facts independently, preserve existing fail-closed prerequisites, and distinguish source-review handoff from runtime commissioning or execution approval.