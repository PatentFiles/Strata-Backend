# Receipt-backed historical capital credit

This is an accounting repair, not a transfer. It does not submit exchange writes, change trading policy limits, enable execution, clear a kill switch, ARM, START, or remove an ambiguous activation journal.

## Evidence and narrow supported case

The authenticated configured owner must have one commissioned, killed, disabled account on subaccount 1 / exchange index 2 and one matching killed/disarmed worker. An exact canonical approved policy, current restricted signer, all retained intents and no-send evidence, all financial events and positions, and the latest digest-valid authenticated ledger reconciliation checkpoint are checked. Historical checkpoints are accounting anchors only, never reused as current trading authority.

The prior checkpoint cash must still equal initial capital plus all retained event cash; positions and event P&L must agree, exposure and reservations must be zero, and no later financial event may be omitted. A fresh full signed exchange read must match every current retained fill/settlement/order and current local cash. Separately, the complete signed subaccount transfer feed must uniquely establish one applied inbound primary-0 to bot-1 transfer on index 2 after the checkpoint. The transfer's independently supplied amount must explain the cash difference. Multiple transfers, missing pages, duplicate IDs, missing exact scope/timestamps, checkpoint-second boundary ambiguity, already registered receipts, and unsupported histories refuse without guessing an adjustment.

Provider contract: https://docs.kalshi.com/api-reference/portfolio/get-subaccount-transfers (reviewed November 17, 2026). It provides applied transfers with transfer_id, from_subaccount, to_subaccount, amount_cents, created_ts and exchange_index; it has no completion-status field. The primary cross-exchange-index leg from the separate intra-account-transfers endpoint is not a bot capital credit and is never counted here; only the applied 0-to-1 subaccount leg on index 2 qualifies. An unrelated POST acknowledgment is never accepted as evidence.

## Accounting operation

Explicit consent binds the full preview scope and SHA. A durable PENDING journal is inserted before signed reads. Under serializable transaction and account/worker/history/credential locks, the complete scope is reconstructed and rechecked. Only `initial_cash_micros` increases by the exact external capital receipt and revision increments. Current cash, trade events, realized P&L, positions, policy limits, original historical funding receipts and execution controls are not changed. The existing actual ledger `finalAccountProof` and every `assertConservation` equation remain mandatory. This raises the manual profit-withdrawal capital floor rather than falsely classifying a top-up as profit.

The immutable receipt is globally unique per owner/provider transfer ID. Cancellation includes the exact stored scope and can create an absent-attempt nonauthorizing REJECTED tombstone in the same transaction (even when another repair already recorded that provider receipt), fencing a POST that never arrived. Conflicting existing scope or another pending provider receipt cannot be reported canceled. Cancellation takes the same journal row lock; it cannot change RECORDED and prevents a pending writer from later committing. A lost COMMIT acknowledgment is UNKNOWN until authoritative readback, never retry permission. Signed proof must remain within 15 seconds at the deferred database COMMIT guard, in addition to application wall/monotonic checks.

## Deployment and operation

Apply reviewed additive `006_capital_credit_repair.sql` explicitly before backend deployment, while stopped. It is not automatically applied by the application. Verify forced RLS, privilege revocations, immutable history and deferred commit guard. Deploy exact reviewed backend then dashboard. No manual receipt inserts or balance/base SQL corrections.

Use preview; present exact transfer ID/time/amount, old/new capital, current cash and unchanged trade profit/loss meaning. Obtain explicit consent to the exact repair. Submit once and verify exact full-scope RECORDED outcome. Keep unresolved journals; supported cancellation may settle a pending repair only. Then obtain new-build fee consent/qualification/owner review and authoritative activation readback as separately required. Deployment or capital repair alone does not prove live readiness. Stop before owner ARM and START.

## Tests

The existing durable safety CI runs new pure transfer/scope/sanitizer tests and the retained-109-history native suite with a real generated synthetic RSA signer, real ledger proof, PostgreSQL transactions/constraints, rollback/cancel/deadline/unknown-commit paths and no live network. The result is isolated engineering evidence, not verification of any production transfer.
