# GitHub Actions usage policy for Strata

Updated: 2026-10-29. This change affects CI triggers and concurrency only. It does not change trading code, SQL, market orders, owner permissions, exchange keys, credentials or deployment.

## Automatic security gates retained
- `ChatGPT V13 diagnostics`: still runs on relevant application/API, database, configuration, dependency, test and Supabase source changes, on PRs and main. Pure documentation/research/screenshot updates do not invoke the long PostgreSQL/build suite.
- `First-party Kalshi tariff evidence parser`: still runs automatically when parser, its tests, dependency manifests or workflow change; manual dispatch remains available.
- `Operator fee-source authorization and final-order regression`: PR and main checks remain, now both scoped to the existing source/test/SQL paths that the PR already used.
- `Kalshi demo-only signed GET proof`: PR and main checks remain scoped to the existing demo-signing source paths; read-only credential-boundary tests remain intact.
- Existing narrowly filtered fee, protective exit, credential recovery, demo isolation, market discovery and wallet security checks remain unmodified.

## Avoid redundant work
- Superseded pull-request runs are canceled for the four broad suites; mainline safety runs are not canceled.
- No secrets added, no test steps removed, no changes to production authorities.
- Manual workflow dispatch remains available where it previously existed; the fee-source regression continues to run when its existing source paths change.

## Trading release verification
Before any trading-related release, verify that all relevant safety jobs actually ran and passed on the intended commit, including relevant credential, fee source, protective exit, account authorization and live order controls. A skipped workflow from path filtering is not a pass. No CI optimization authorizes trading or order placement. Review any GitHub branch protection required-check names before enabling it.

## Billing
GitHub Settings > Billing and licensing > Actions governs budgets, usage and payment; no owner account settings are changed by repository code. Inspect workflow bills over a complete billing cycle to quantify actual savings. Public/private repository billing may differ by runner and historical visibility.

## Rollback
Revert these workflow-only changes through an ordinary PR if an essential automatic gate is accidentally suppressed. Do not force-push or clear Git history.
