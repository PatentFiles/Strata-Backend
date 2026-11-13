# Brit handoff acceptance — C52/53, execution disabled

**Source-review handoff only. Runtime commissioning is BLOCKED.**

PR #1: https://github.com/carrolldbrady-hub/btc-kalshi-v13/pull/1  
Branch: `chatgpt/diagnose-v13`. Final revision is the PR head; use
`git rev-parse HEAD` and its matching diagnostics check, not an older passing run.

## Reconciled baseline

- PR #1 contained `cb67dedcf672a9cc68d7bf362ad1e8ead514853d`, including the
  dashboard and shared C52/53 integration. Diagnostics #182 passed on that exact
  revision. The former PR description incorrectly cited `b60a456…` / #181.
- Main remains separate at `72fd0e2…`. No merge or preview-source switch is part
  of this handoff. Both main and the commissioning-repair worktree were clean
  when inspected; no uncommitted work was discarded.
- `review/v13-commissioning-repair` remains separate and unapplied in PR #2.
  It is NOT included or implicitly approved by this handoff. Its actual Drizzle
  adapter now has isolated PostgreSQL tests with synthetic authentication.
  Consult PR #2's exact-head checks and acceptance note; runtime use still needs
  independent review and separate owner approval.

## Actual read-only verification — 2026-10-07 UTC

Command: `(cd scripts && node --import tsx verify-live-readiness.ts)`

The direct CLI preserves exit 2 for blocked readiness. `pnpm exec` can normalize
that to exit 1; both are failures, not readiness approval.

| Check | Actual evidence |
|---|---|
| Database target | DEVELOPMENT, independently matched database/server/OID fingerprints |
| Shell application mode | `NODE_ENV` missing; not used as database-target proof |
| Environment account binding | `primary_nonexclusive`, configured subaccount `0`: MISMATCH |
| Historical singleton | FROZEN, primary/subaccount 0, exchange index NULL: MISMATCH for dedicated commissioning |
| Singleton dedicated linkage | **0/17 fields present**, including funding anchor, baseline, checkpoint and restricted-key binding |
| Historical archive | VERIFIED; one preserved FROZEN commissioning snapshot |
| Dedicated `(1,2)` boundary | VERIFIED historically funded; installed INDEX2 identity/fingerprint MATCH |
| Provisioning | VERIFIED `handoff_confirmed`, exact restricted scopes, verified creation |
| Funding record | VERIFIED reconciled $25 `(0,2) → (1,2)`; not evidence of fresh current cash |
| Separate pair fee approval | VERIFIED recorded $1 approval; not new approval or fresh fee authorization |
| Local live ledger | Zero orders/fills/settlements; two historical BLOCK decisions |
| Gates | Kill switches ON; both micro-live execution flags OFF; shadow execution OFF |
| Database conclusion | **MISMATCH** |
| Kalshi conclusion | **INCOMPLETE**: signed GET scans intentionally NOT_STARTED under existing prerequisite guard |
| Readiness / exit | **BLOCKED**, exit **2**, execution authority **NONE** |

Root cause: `.replit` development settings explicitly retain
`MICRO_LIVE_ACCOUNT_MODE=primary_nonexclusive`, while the shared selector is
`KALSHI_BOT_SUBACCOUNT=0`. The old singleton is likewise primary-bound.
Separate funded-pair records do not initialize or rewrite that singleton.
Nothing proves that the dedicated pair's missing linkage was ever commissioned.
Changing shared credentials/selectors would not repair the durable evidence and
could redirect unrelated flows. No settings were changed to make this check pass.

The verifier does not claim a failed Kalshi authentication when requests were
not started. Fresh account activity, cash and permissions remain unverified.
A funded archive, approved historical fee record, fresh dashboard fetch or
paper profit cannot substitute for these missing runtime prerequisites.

## Implemented production source; independent review remains required

| Implemented production path | Acceptance boundary |
|---|---|
| Separate production consumer/executor/ledger | Real PostgreSQL; simulated exchange; no startup registration |
| Atomic all-in reservations and logical one-use fences | Concurrent claims, policy locks and pre/post-POST crash tests |
| Exact signed-history reconciliation and immutable journal | Cash, basis, fee, reservation and realized-loss conservation |
| Cancel races, late fills and residual reduce-only exits | Fractional quantities, canonical NO mapping and settlement tests |
| Owned-position evaluation and startup/restart recovery | Paper state is not exit authority; GET-only recovery works disabled |
| Dedicated adapter and default market/fee/account readers | Runtime approvals/permissions/cash precision remain unproven |

Brit independently reviews the completed source and acceptance evidence, rather
than implementing deferred executor/ledger paths. See
**[V13_PRODUCTION_ACCEPTANCE.md](V13_PRODUCTION_ACCEPTANCE.md)** for the source map,
22 real-PostgreSQL acceptance cases and safe reproduction commands. The complete
local suite passed **281/281**, zero skips, against new temporary PostgreSQL only.
No API startup registration, runtime schema application or activation is included.
Do not raise micro-live constants or treat paper state as live order authority.
Synthetic exchange tests prove neither broker behavior nor readiness/profitability.

Selected launch strategy remains **V1.3 C52/53**:
`v13-champion-2-c52-confirm53`,
hash `314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161`.
Research-only sizing and challengers cannot promote themselves or approve capital.
Paper results and passing mocked tests establish neither live readiness nor profitability.

## Acceptance checklist

- [ ] Review the **final PR head** and diagnostics check on that exact SHA.
- [x] Reconcile local history; preserve the separate repair branch and unrelated work.
- [x] Reproduce and document actual blocked read-only readiness; do not bypass it.
- [x] Add verifier tests to CI and typecheck the previously excluded verifier.
- [x] Test all 17 linkage omissions, invalid checkpoint identity/digest/time,
  global kill-switch enforcement, exit codes and mutation-query refusal.
- [x] Test stale/failed/future-dated dashboard observations; distinguish account
  paper-history storage from a production trading ledger.
- [x] Implement separate production paths; validate transactions, restarts,
  uncertainty, owned exits, fractional fills and conservation in disposable PostgreSQL.
- [ ] Brit independently reviews the final source revision and acceptance evidence.
- [ ] Owner separately authorizes any development commissioning repair only
  after disposable-database validation and review of its exact branch.
- [ ] Later: approve intended runtime/account binding without replacing shared
  credentials; establish fresh complete authenticated pair/account evidence.
- [ ] Later: complete champion-selection review, production policy/fee approval,
  arming and controlled-size commissioning as distinct owner decisions.

For the complete implementation/risk contract, start with
`V13_LIVE_MONEY_HANDOFF.md`, `V13_FINAL_CHAMPION_SELECTION.md`,
`V13_STRATEGY_RESEARCH.md` and the linked research studies.
