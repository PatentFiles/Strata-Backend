# Strata STOP → DISARM → change bot — protected-exposure release

Status: isolated staged implementation. Do not deploy during an owned protective position, UNKNOWN order, or uncertain financial reservation.

## Root cause

The owner correctly pressed STOP and DISARM. The production account retained an owned protective worker (ARM request false), one open NO position, two nonterminal/financially unresolved intents, and USD 3 reserved. The protective EXIT is UNKNOWN, and signed history currently refuses at exit_recovery_order_not_unique. That means matching exchange-order evidence is absent or ambiguous; neither outcome is proof of no fill, a terminal cancellation, or a closed position.

The older frontend called POST /bots/prepare-change immediately after DISARM and translated the protective worker into the misleading error "bot worker must be stopped". The backend also had separate credential-bound and fallback DISARM routes; their lease finalization rules differed.

## Implemented lifecycle

- STOP and DISARM acquire account locks before lease locks. Both retain an owned lease while authoritative positions, intents, reservations or undisclosed cash exposure exist.
- If the authoritative exposure proof confirms flat, both control routes release the owned lease, disarm the account and preserve all ledger history.
- A protected worker keeps its normal protective-exit/recovery loop running after STOP. A bounded, protected-stop-only callback checks the existing owner-scoped STOP finalizer every ~10 seconds and finishes the lease once the exchange/ledger agrees the account is flat. Regular live-entry workers never install this callback.
- The bot catalog returns separate reasons and counts for protective exposure pending, worker releasing, or verified stopped. Owner /bots/prepare-change may request the same guarded STOP finalizer only for an exact confirmation and a provably flat, stopped owner account; it never submits orders or clears a financial hold.
- DISARM UI shows protected management, not "cash preparation failed", and checks for automatic completion while the operator remains on the page. Bot/stake controls remain disabled until the server proves release.
- Signed history diagnostics now separate zero exact order candidates from multiple candidates, but **both still refuse** authority and preserve UNKNOWN. Logs avoid raw order identifiers and signed provider payloads.
- Original C52/C53 strategy code and Warren Buffett signal, freshness, stake and order controls remain unchanged.

## Tests

- Native PostgreSQL STOP/KILL/authorization interleavings, released lease, protected unknown exit: full 72-test suite passed on pre-final wording, then rerun bound controls after final wording.
- Credential-bound DISARM cases, multi-owner isolation, owner-scope guards: 9/9.
- Pure supervisor protected auto-finish tests: 3/3.
- Signed protective-exit history reader diagnostics: 26/26.
- Frontend DISARM polling, no-start and state text: 4/4; frontend typecheck/lint/build and account-control regressions passed.
- No real exchange orders and no production database mutation.

## Deployment gate

Do not merge/deploy backend while the existing account holds a protective lease or UNKNOWN order; a restart would interrupt its recovery process and change the release SHA. First obtain genuine signed terminal order, position and settlement evidence, reconcile reserve and fees, then verify zero exposure and a released lease on the exact owner account. Do not forcibly delete or relabel a historical exit.

When flat and the exact tested backend commit qualifies, merge backend and publish the matching frontend. Verify STOP → DISARM → bot change → ARM → START using isolated test accounts before approving new live use. Replay the same stale/unknown protections after rollout.

This patch fixes lifecycle completion and messaging. It does NOT fabricate a terminal exchange outcome or guarantee a currently UNKNOWN order will resolve without valid provider evidence.
