# Explicit historical owner-assumed baseline (isolated candidate)

Base: draft backend PR #339 at 645c04c. Nothing here grants deployment or START.
The prior genuine-current-capture path remains unchanged and remains the default.
There is no automatic fallback when the issuer returns 429.

## Meaning and provenance

The new path reads only release-controlled repository PDF bytes with SHA256
`c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601`.
The strict parser must recognize the July 7, 2026 standard quadratic model. This
proves which historical bytes/formula the owner selected, NOT issuer authenticity,
current publication, present base rates, or an independently verified fee ceiling.
The existing AAL2-authenticated owner acts as operator and consenting party. There
is no second operator, independent-review attestation, network capture, renewed
capture timestamp, or fabricated expiration.

The immutable model uses `owner_attested_historical_terms_v1` and
`OWNER_ATTESTED_HISTORICAL_BASELINE`, with `genuine_source_verified=false` and a
NULL capture ID. Registry bytes have SQL hash checks, strict enrollment parsing,
and update/delete refusal. Immutable model/receipt/attempt scope binds owner,
account, code SHA, exact previous policy, baseline ID/digest and explicit new
historical consent. Public readback distinguishes authenticity from currentness.

## Explicit choice and limitations

Both `STRATA_DURABLE_OWNER_FEE_ENABLED=true` and the separately default-off
`STRATA_DURABLE_HISTORICAL_BASELINE_ENABLED=true` are required. The owner must
select the historical preview, then accept its dedicated attestation and risk
statements. Old OFFICIAL-terms consent cannot authorize this source. Unknown
responses never authorize replay; existing scoped readback/cancellation rules
remain mandatory.

The owner accepts that current base rates and source authenticity are unverified,
that publication-change detection has gaps, and that unbounded-fee exits may
block. Absence of a different observed capture is not evidence of no change.
All known differing captures, including expired ones followed by matching
reversions, block enrollment. Later conflicting captures serialize with account
writes and latch the model closed. The monitor includes historical models rather
than dropping them through a NULL-capture join. It performs no new issuer fetch.

Every entry/exit still needs exact current market applicability, original-source
five-second wall/monotonic deadlines, and existing technical, owner, credential,
position, ledger, risk and final transaction fences. A source proof is not trading
authority. Configured risk limits are copied exactly; their preservation is NOT a
guarantee that unseen changed issuer fees fit those limits. Missing/changed fee
metadata never creates guaranteed automatic exits or a relaxed emergency path.

## Installation and evidence

The unmerged one-time atomic schema candidate 003 is extended here. Do not apply
it over an installed durable schema. If any such installation exists, prepare and
review a separate upgrade migration rather than bypassing duplicate-object errors.
Runtime identity, least-privilege/RLS, real authenticated browser flow, real
exchange latency, coordinated frontend/code/schema release and explicit owner
activation remain separate release gates. Existing account and production state
are untouched. No fee-model or test result is authorization to trade.

Native tests use genuine local parser/SQL, but historical repository fixtures,
synthetic provider/credential results and isolated databases. They are not current
issuer evidence or a live order/fill/recovery certification.
