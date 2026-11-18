# Experimental shared authenticated Read admission and bounded credits

Default OFF. No migration, setting, or production action applied. The frozen per-request baseline remains in a separate checkout; this prototype supersedes its dispatch mechanics only for isolated testing.

Enable only with `STRATA_MEMBER_READ_BUDGET=experimental_v1` and exact `STRATA_MEMBER_BUDGET_OWNER_ID`, `STRATA_MEMBER_BUDGET_ACCOUNT_ID`, `STRATA_MEMBER_BUDGET_CONNECTION_ID`. Current verified/unrevoked signer fingerprints must map to that owner/account/provider connection, Kalshi financial account and pair1/2. Setup, restricted, verification and provisioning roles share one conservative database bucket across replicas. This is not proof that arbitrary app owners are separate provider members. Unknown scopes fail closed.

Refill300 tokens/s, internal cap750. The lower cap reserves150 tokens for at most500ms debit-to-dispatch lag. All charged mapped Read GETs and known Read-cost mutations receive opaque one-use tickets checked after signing immediately at fetch. The bounded snapshot can atomically reserve60 for six exact first pages; further pages debit independently. Balance remains separately limited by the existing1.2-second limiter and receives a distinct binding-only ticket. This hybrid revalidates exact current credential binding for every first page; see [hybrid.md](hybrid.md). See [credits.md](credits.md) for the interval proof, unchanged source clocks and explicit database-clock assumption.

Cold initialization creates zero tokens, not assumed remaining provider capacity. Failed admission can perform one bounded local wait based on the full-cost deficit upper bound, capped250ms, and one database recheck. No provider retry occurs. Committed debit is never refunded on abort, expiry, failed provider response,429, lost acknowledgement or execution rollback. Database row-lock waiting is capped250ms. Real production admission uses an independent autocommit pool query, never the owning ledger transaction.

Verified cost/configuration provenance is in [evidence.md](evidence.md). These observations are capacities and costs, not remaining quota. External clients, deployments without this limiter and unsigned public-IP traffic are outside its control. Old900-cap/no-ticket workers must be excluded before rollout; existing stored tokens must be clamped downward to750. Database privileges and production application require separate review.

Mapped modern scoped reads, verifier reads, setup creation/keygeneration/transfers, legacy trading reads and precision reads are supported. Remaining legacy funding/provisioning/recovery families explicitly refuse when enabled; see [legacy coverage](../latency/member-budget-legacy-coverage.md). No authorization, money movement, order intent, automatic retry, source deadline or accounting rule is granted by a quota ticket. Order Write and upgrade Write paths remain unchanged.

Tests use explicit query injection only in isolated fixtures. The module lazy-loads the database after enabled configuration validation, preserving formerly pure default-off imports. Full-path timing is synthetic and must not be presented as a live-fill guarantee.

This integrated isolated checkout adds guarded six-lane scheduling; see [guarded-six.md](guarded-six.md). Legacy/default-off remains two, and held/recovery remains serial.
