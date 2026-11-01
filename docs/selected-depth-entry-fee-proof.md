# Selected-depth PREPARE fee proof

## Demonstrated edge case (offline, not an attributed live incident)
A fresh verified book with 0.50 contracts at 37 cents and ample depth at 38 cents
was refused for fee-limit mismatch. The preliminary reader's best-price-only
planner could not buy a whole contract at 37 cents, so its fee basis fell back to
one contract at 37 cents. The cash-aware planner could afford three at 38 cents
under the original 44-cent reference and 625-cent all-in maximum, but correctly
could not borrow the 37-cent fee proof.

The actual 01:10 production intent had abundant top-price depth. Its final fresh
comparison inputs were not retained. This edge case is NOT established as the
cause of that refusal, and this patch does not chase a moved market or promise a fill.

## Narrow change
The existing independently verified reader retains its exact bounded price-grid
descriptor with the fee model. For deci_cent metadata omitting price_ranges,
this remains the existing conservative full four-decimal fallback bound, not
newly proven venue tick precision. Explicit tapered ranges are used in the
reported reproduction. PREPARE validates the descriptor's digest and
recomputes the old basis bounds before using the same model to mint an exact
selected-price/count receipt. The planner still obeys original source and
strategy price ceilings, actual depth, whole ENTRY quantity, gross stake,
conservative all-in cash, capital and loss limits. It never reuses a fee amount
from a cheaper price. Existing receipts without descriptors keep legacy behavior;
malformed supplied descriptors fail closed.

The exact selected receipt and cash proof are pinned in the intent capability.
No existing intent is repriced. FINAL comparison, signed-book checks, immutable
request quantity/limit, five-second source and quote age, approvals, exits,
UNKNOWN/no-send semantics and client identities remain unchanged. Original
verified/read/source timestamps are preserved. No network requests, migrations,
credential changes, new fee model or provider-signature claims are introduced.

The shared existing fee formulas initialize the DB package on module import;
therefore affected standalone test scripts use the existing isolated disposable
PostgreSQL runner, not a production URL. The new helper is covered by the existing
safety workflow path filter and cash-risk test command.

## Validation
Actual disposable-PostgreSQL acceptance covers both YES/NO shallow-top preparation
and synthetic dispatch, preserved timestamps with an advancing await clock,
exact 5000ms versus 5001ms boundary, insufficient fractional-only depth, depth
above the original ceiling, stale fees and tampered grid. Existing ENTRY/EXIT,
recovery, reservations and ledger acceptance remain in the same suite.
The helper's independent tests cover malformed/reversed/missing grids, digest
mismatch, side complements, old-bound forgery, price/count quantum and deep clones.
Production qualification remains a separate controlled-release task; this work
was local only and does not disrupt the current live worker.
