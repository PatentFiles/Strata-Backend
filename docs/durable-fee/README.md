# Isolated durable fee candidate, November 17, 2026

Base: `202f5d3594468ec94617761b03b8916ec48621a9`. No production, deployment, PR or Brit checkout changed. Not release-ready.

## Implemented locally

- Immutable, versioned, explicit owner fee consent bound to genuine original capture, account, code SHA and approved policy hash. Durable approval has no periodic PDF lease/24h consent expiry in this new mode. Existing modes are unchanged.
- Trusted server enrollment function verifies stopped commissioned account, exact durable policy scope, original canonical bytes/hash and existing strict V3 parser. Atomic model/state write; deferred capture expiry/change guard; uncertain COMMIT denies blind retry and supports exact-owner durable readback. Authenticated status, atomic migration, exact-scope readback and entry-revocation routes are registered behind existing user/AAL2 middleware; feature remains default-off. Standalone HTTP enrollment is retired409; atomic migration is the sole public model producer and requires separately recorded uncertainty/exit-risk acceptance.
- Operational verifier makes zero PDF requests. It locks model/state/account/policy and runs the existing current-market, event, series and upcoming-change verifier. It binds exact source/model UUID, policy version and formula.
- Publication inspector reads ALL uninspected genuine captures, including expired history. Per-capture audit rather than a sequence watermark avoids losing late lower-ID commits. Changed-then-reverted evidence remains latched. Invalid provenance/oversized backlog fail closed. Missing capture means unavailable, not unchanged. Inspector never acquires a capture, changes egress or adjusts cooldown.
- Transactional capture INSERT trigger latches differing terms with the producer write, using shared account/state locks to serialize enrollment/final send. Admission does not wait for background monitor scheduling to notice already captured changes.
- Candidate final-send adapter preserves strict deployed V3 order/origin restrictions and financial account/global kill, credential, worker and technical authority fences. It substitutes only the fee phase, uses the caller's existing transaction and invokes transport once. Candidate supervisor startup/per-market/final transport and emergency/held protective consumers now select this mode only from exact approved durable policy identity. Native tests now cover migration→qualification→review→activation with synthetic signed exchange GETs; no worker START or real orders.
- Entry consent revocation does not revoke a separately reviewed protective fee proof. Known new terms or unavailable current market metadata have no verified hard fee cap; these remain explicitly blocked/unbounded, not guaranteed automatic exits. Real position/ownership/reduce-only validation is still the executor's responsibility.
- Reviewer-detected DATE decoding fixed via SQL `::text`. Full positive-timezone run exposed the existing PDF parser's civil-date issue; candidate-only `microLiveFeeArtifact.ts` normalizes dates in UTC without relaxing document/rate/hash checks.

- Public migration identities are reserved once in a body-bound attempt ledger. A durable exact-scope REJECTED/noCommit receipt requires held-row verification that no model committed. Failed attempts cannot replay their old model ID; only a fresh reviewed attempt can proceed. COMMIT_UNKNOWN stays unresolved unless exact readback proves outcome. Explicit owner cancellation can safely resolve a PENDING/no-model attempt under the same transaction lock; a delayed original writer cannot pass its required PENDING check afterward. The no-commit proof lives in the immutable terminal attempt ledger; the ordinary observation event is not itself immutable under the existing schema. Active write transactions cause bounded refusal, and committed work returns its recorded outcome rather than a cancellation. A separately re-confirmed cancellation after fresh UNKNOWN readback is idempotent; no automatic cancellation or migration replay is permitted. Concurrent rejection waits behind active migration and cannot mislabel committed work. Authenticated cancellation endpoint and independent readback have been exercised with actual SQL and synthetic MFA middleware. Real-browser/authenticated-service validation remains outstanding.
- Authoritative DDL is `lib/db/owner-self-release/003_durable_owner_fee_v1.sql`, one atomic transaction. The docs schema path is a symlink, not a second definition. Late-error rollback removes all new objects; duplicate application fails closed rather than silently accepting schema drift. No runtime grants are included.

## Evidence

-132 offline durable/consumer/standing/protective/V3 migration/qualification/activation regression tests passed (including25 core durable tests).
-One HTTP test exercises authentication ordering/no-store/refusal across8 durable routes using synthetic authentication middleware, not a real AAL2 session.
-28 existing PDF artifact/parser tests passed.
-9 PostgreSQL16 core groups,11 lifecycle groups,5 final-wire groups and20 atomic migration/recovery groups passed in the final independent45-group run (exit0). Earlier independent review also exercised production policy/account CHECKs, mutual FKs and uniqueness.
-Independent activation harness reports18 tests, actual enrollment→qualification→review→activation, with synthetic exchange/provider fixtures. Full actual migration→fresh request→qualification→review→activation adds3 scenarios/4 Node tests; independently rerun after final source changes. Same-SHA refusal and old-SHA revocation confirmed.
-The full native suite passed with `TZ=Asia/Tokyo` after date fixes.
-Full workspace `tsc -b` passed.

Native tests execute actual strict PDF parsing, model/monitor SQL, enrollment concurrency/rollback/deferred expiry/lost-COMMIT readback, actual final account/durable row locks, revoked-entry/independent-exit fee behavior, and one simulated transport on UNKNOWN. Concurrent revocation AND capture insertion wait through the simulated transport and COMMIT; a subsequent send refuses changed/revoked state.

Capture/account prerequisites are synthetic test tables/rows. Historical repository PDF is a fixture, NOT current provider evidence. Provider HTTP/order transport and technical approval predicates are mocked. No exchange request, real order, signing, position reservation, partial-fill or full recovery chain is exercised. Native tests are groups, not a claim that the repository's complete safety aggregate passed.

Run with preinstalled trusted tools from repo root:
```
PG_BIN=/path/to/postgresql/bin PG_SHARE=/path/to/postgresql/share bash docs/durable-fee/run-native.sh
```
The script builds current modules, creates only a new disposable loopback database on port55483 and stops it on exit. Do not point it at an existing database.

## Remaining release gates

1. Atomic stopped-account migration is implemented, preserving every approved limit/strategy field. Native tests cover concurrent exactlyone, five rollback boundaries, UNKNOWN COMMIT/readback, exact priorpolicy CAS, credential revocation, enabled-account refusal, native preview SQL, and pre-mutation same-SHA approval refusal. Full migration→activation native extension now passes; real authenticated browser tests remain. A separately isolated migration UI exists, but its baseline is not verified current deployed frontend.
2. Trusted monitor scheduling/alerts, issuer-access recovery and observation retention. New captures still come only from the existing verified collector; this code cannot fabricate a current capture or cure429.
3. Full-chain native tests of candidate supervisor branches, actual signer, position/ledger, fractional/partial-fill and emergency recovery integration; authenticated real authenticated browser tests. CI/package scripts added locally, not run on GitHub. Feature-off consumer and refusal-route tests pass.
4. Exact production-role privileges, RLS and capture-trigger lock-order/load validation. SQL adds no runtime grants. Capture trigger and monitor require reviewed permissions; role mismatch must fail closed, not bypass RLS.
5. Independent review of policy semantics and all additions, especially source provenance and final transaction ownership. Independent source reviews found no critical issues in tested scope; this is not a deployment approval. The current query type itself is not proof of an open transaction; real callers must supply the trusted executor transaction.
6. Explicitly review the publication-monitor outage risk contract. Candidate accepts owner-approved historical economics plus fresh API applicability while returning `publicationKnownCurrent:false`, including never-checked/unavailable monitor states. Atomic migration separately requires explicit owner acceptance of that uncertainty and possible unbounded-fee exit refusal. This does NOT establish an unseen base coefficient remained unchanged. Do not deploy indefinite unavailable-monitor acceptance without an explicit reviewed decision.
7. No independently verified exchange-enforced worst-case fee ceiling exists for unavailable market metadata. Safe automatic exits cannot be promised under that condition.

Current deployed V2 account,24h V3 standing permission and all trading controls remain untouched. This is a tested isolated implementation, not START clearance.


## Fresh-source deadline hardening (draft PR follow-up)

The durable verifier now measures from before its earliest direct API request,
not completion of the last response. Both wall-clock and monotonic elapsed time
must remain within five seconds. A process-local callback retains that original
clock through normal final transport, emergency post-RSA signing, and activation
pre-COMMIT. It cannot be reconstructed from a serialized receipt. The existing
PostgreSQL deferred COMMIT guard remains in place; no live-order permission is
created by these tests.

Validation: 155 offline tests plus two emergency RSA boundary cases, 45 native
PostgreSQL groups, 19 activation tests and four full-chain tests passed locally,
as did the complete workspace typecheck. The emergency runner is part of
`test:durable-fee-offline`. It uses test-only bundler replacements for policy and
authority discovery and synthetic database/transport, while executing the actual
core freshness callback, emergency dispatch and RSA signing. Wall-clock rollback
cannot hide a source age of 5,001 ms. These are not live exchange latency proofs.
Prior log files above are historical snapshots, not logs of this follow-up.
