# Direct-precision sizing groundwork

This release is inactive by default. It does not enable trading, alter account controls or risk limits, generate approvals, grant database access, or apply the candidate authority schema. No production constructor enables `directPrecisionSizing`.

## Scope

The configured stake is a gross purchase ceiling, not a guaranteed minimum spend. The planner maximizes executable whole contracts within that ceiling, visible depth, signal price limits and independent cash/risk gates. A higher account balance is already permitted by the $25 minimum funding check; it does not automatically increase approved risk capital.

The legacy non-direct rounding model remains the default. The optional direct model requires independently reviewed account/key/documentation authority and authentic current numbered-subaccount evidence. Structural validity, numbered request defaults, decimal balances and passing tests cannot supply that authority.

For reviewed multiplier-one quadratic fees and direct $0.0001 balance alignment, exact integer fragment bounds allow nine contracts at a $0.52 limit or eleven at $0.43 under the existing $5 gross/$6.25 all-in caps. These are conditional examples, not executed trades or guaranteed fills. Separate entry and exit-loss reserves remain; no future rebate reduces the bound. Price-dependent sizing and fresh-grid checks preserve the original pinned request.

## Runtime boundaries

Metadata refresh is coalesced, rate-limited and nonblocking after signed exposure reconciliation. Missing or expired evidence refuses entry in opted-in mode. Current authority is reread in a separate statement after the final account lock, using its existing transaction. The registry requires READ COMMITTED. The candidate mutation trigger serializes authority changes on that same account lock.

Final validation uses an opaque identity unique to the active transaction, not the reusable pooled database client. Concurrent read generations cannot publish stale validation. The final wire check refuses expired evidence without resetting the original five-second quote clock. Protective EXIT reads and reduce-only transport retain their separate path.

## Qualification and remaining activation

The focused offline suite passed 186 cases before an additional mixed-price/maker/taker pre-rebate test was added; the five arithmetic tests including that addition passed separately. API TypeScript and production bundling passed. Independent source review found no blocker for an inactive release. Real isolated PostgreSQL 17 qualification passed fourteen migration/locking/RLS groups, including credential-revocation locking. The grouped precision suite passed52/52 through the normal disposable PostgreSQL runner.

A local full native run stopped at the existing restricted protective no-send scenario. Baseline also failed that scenario at a different stage, while unmodified candidate and baseline isolated reruns both passed. The strict freshness guards remain unchanged. This local aggregate is not a PASS. Required exact-head hosted safety checks must pass before merge.

Activation requires qualified database grants/schema, genuine current authority and fee review, exact-release approvals, and separate explicit operational action. This groundwork alone does not change live sizing or authorize START.
