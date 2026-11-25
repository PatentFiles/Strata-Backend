# Paper process isolation
The API start command no longer starts the server paper scheduler. The paper
worker uses the original strategy, cadence, and exclusive database lease, but
cannot send a process-local paper wake or call the legacy micro-live execution
hook. User-owned live entry and protective-exit code, reconciliation, risk,
fee, and quote-age checks are unchanged. No runtime migration is automatic.

## Staging and cutover
- Build the release, run `pnpm --filter @workspace/api-server run test:paper-process-boundary`,
  and run the paper-worker and live worker safety/regression suites in
  disposable environments. Exercise startup, exclusive leasing, rollover and
  SIGTERM against a disposable database and no-order feeds before rollout.
- Use a **dedicated, private** paper service with start command
  `pnpm --filter @workspace/api-server run start:paper`. Do not configure an
  HTTP health check. Set the ordinary exact paper entry-policy approval,
  `NODE_ENV=production`, and `FORWARD_TEST_PRODUCTION_WORKER_ENABLED=true`
  explicitly for that service. Set `STRATA_PAPER_DATABASE_URL` to a distinct
  least-privilege paper role. Do not inherit API database or credential
  settings, live provider signing keys, or live flags. Verify paper tables and
  optional research grants in staging; do not grant execution or credential
  storage access. A separate runtime can still share database resources if both
  services use the same database.
- Before a controlled live release, inventory active users and any legacy
  execution path that relies on paper. The former paper-triggered legacy
  micro-live cycle stops when this API revision takes over. Do not cut over
  while a legacy position, nonterminal order, unknown outcome, or an active
  worker could depend on it. Coordinate a stopped, reconciled cutover and
  exact-release authorization through the existing controls.
- Start the API without the old scheduler; verify health and API boot logs.
  Wait for the old paper lease to expire or release, then start exactly one
  dedicated paper service and verify its separate deployment identity and
  continuing paper evaluations. Check that it cannot access execution tables or
  create orders. Verify independent entry/held-exit evidence separately; fresh
  paper/PASS rows do not prove order latency.
- Roll back only with the same stopped-account checks. Stop the dedicated
  paper service first so the previous API revision does not compete for its lease.
