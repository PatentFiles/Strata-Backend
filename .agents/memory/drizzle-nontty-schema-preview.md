---
name: Drizzle non-TTY schema preview
description: Safely interpreting strict verbose Drizzle push output in this shell environment.
---

`drizzle-kit push --strict --verbose` in the non-interactive shell prints proposed SQL, then may report a TTY-required prompt error. That output is a review aid, not proof a migration applied or was rejected.

**Why:** A pipeline can mask the tool's status, and a package-manager invocation may return success despite the nested prompt error. Reading the SQL alone can therefore misstate database state.

**How to apply:** Before any schema write, verify the actual connection against explicitly targeted development and production fingerprints. After a strict preview, query schema metadata read-only to confirm whether columns or checks changed. Apply only a reviewed, additive development diff without force, then verify the historical run and constraint definitions again.