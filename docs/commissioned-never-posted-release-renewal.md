# Commissioned, never-posted-only owner SHA renewal

## Scope and rollout
Base: deployed `3d1981d16e87b3ef6e54f1d30dcc381ebb495986`, source tree `77e17c8af6af2f967f9ca1ee404fa071e8b757db`.

This fixes the demonstrated owner-approval dead end after retained terminal BLOCKED / PROVEN_NOT_POSTED entry attempts. It is **not general release renewal after actual fills or settlements**. Such histories, monetary events, nonzero basis/P&L, and any protective reservation history remain explicitly unsupported by this new branch and require a separately reviewed complete reconciliation design. No historical row is deleted or relabeled.

No schema migration, new SQL permission, dependency, environment variable or frontend request change. After normal reviewed deployment, the existing authenticated owner qualification and owner-authorize action can record consent for the exact deployed SHA. AAL2 owner middleware and existing explicit confirmation remain mandatory. Chat/operator approval does not execute that owner action. Existing independent review, continuous-owner consent, technical release, ARM and START remain separate gates; this function cannot create them.

Only a new owner SHA approval (or its already existing ID) and an authorization audit receipt are recorded. Account eligibility/kill bits, global controls, worker state/ARM/fence, prior approvals, standing grants/reviews, policy and financial history are unchanged. Rolling back code reinstates the old history blocker; retained approvals and audits must not be deleted.

## Authoritative evidence and fences
- Bootstrap/commissioning repair remains empty-history-only. Disabled-account restore remains its existing, separately consented mode.
- The narrow branch requires an enabled, commissioned, unfrozen account with retained history, current owner activation digest and approved unchanged policy.
- It requires the latest historical continuous grant, including its revocation status, and its unrevoked matching owner SHA approval and distinct independent review, all bound to the same owner/account/SHA/policy. A newer revocation cannot fall back to an older grant. Historical qualification/digest and consent chronology are checked; no old human attestation is copied into a new one.
- Every retained intent must be whole-contract ENTRY BUY/IOC, terminal BLOCKED, with zero fills/reservation, no exchange order ID/cancellation/parent. Client ID, market, side, whole count and price are bound to the existing capability digest. Each must have exactly one same-account, exact-intent, digest-valid PROVEN_NOT_POSTED observation and no contradictory POST_ATTEMPT/POST_UNCERTAIN or financial event. A reason string or BLOCKED status alone never suffices.
- Existing no-send observations contain `{id,reason}`, not a standalone request signature. The proof uses the trusted database join to the separately validated immutable capability/request/client identity. A malicious database writer able to rewrite all records and recompute every checksum remains outside that trust boundary. The new authorization audit retains request/capability/observation digest bindings without rewriting old receipts.
- The private restricted key is loaded through same-owner financial/provider/credential relationships and its actual RSA material fingerprint is recomputed. Full signed current+archived history must be complete, empty of orders/fills/settlements/nonzero positions, and exactly match persisted cash. Any contradictory provider order blocks; absence is never imputed from unavailable archival history.
- No provider await occurs under DB locks. Account/policy/credential/provider/financial/lease row revisions are compared before/after I/O (including ARM→DISARM ABA). Final account and lease UPDATE locks, shared policy/credential/prior-authority/history locks, and history digest rechecks serialize approval against START, revocation and mutation.
- Freshness uses the existing owner-approval contract: signed evidence must remain within **15 seconds**, and qualification retains its ordinary expiry plus existing60-second remaining-expiry headroom. A five-minute-old still-current qualification is tested. No new60-second human-response deadline; trading's five-second quote limit is unchanged.
- The source is bounded to1000 historical intents and3000 matching transport observations. Oversize or ambiguous histories fail closed with an explicit bound reason.
- Current-SHA replay is idempotent after fresh checks. Lost COMMIT acknowledgment remains an uncertain approval outcome; retry cannot create duplicate approval or dispatch an order.

## Read-only diagnostic alignment
The owner signed-exchange diagnostic uses the same validated no-send partition. It maps provider records against **all** request identities, explicitly rejects any provider record contradicting an excluded no-send request, and only then removes verified never-posted requests from the expected provider-order count. It rechecks history after every awaited diagnostic phase. Other historical submitted requests retain the previous strict flatness behavior; the shared migration flatness helper is not weakened. The diagnostic still writes nothing and grants no trading or fee authority.

## Local evidence
New `--renewal` runner mode uses a new random-port disposable PostgreSQL database with stripped credentials and an external-network fence. Fixture provider reads and identities are synthetic; this is not a production qualification, acknowledgment or fill. Real PostgreSQL exercises SQL joins, locks, concurrent sessions, unique approval identity and commit-ack ambiguity.

-57/57 renewal/diagnostic tests: five valid no-send intents; current-SHA replay; no control/history changes; no locks during provider await; UNKNOWN/nonterminal/reserved/filled/ACK cases; missing/forged/duplicate/cross-account proofs; request/client/decision mutation; POST contradictions; monetary/position/protective history; missing/revoked/mismatched prior authority; foreign owner/qualification; stale/negative clocks;15-second inclusive boundary and older valid qualification; partial archives; cash mismatch; provider exposure; ABA; post-read mutations; concurrent renewals; real NOWAIT locks on account, worker, intent, receipt and grant; lost COMMIT acknowledgment; diagnostic provider contradiction and mixed duplicate-client identity.
-12 legacy owner SHA unit tests;9 legacy diagnostic unit tests;1 existing diagnostic PG test;12 existing owner-restore PG tests.
-API TypeScript and backend build pass. Full combined suite and exact remote CI remain integrator responsibilities.

Commands (tooling PATH must provide pinned pnpm and PG17):
```
node artifacts/api-server/scripts/run-v13-disposable-postgres.mjs --renewal
node artifacts/api-server/scripts/run-v13-disposable-postgres.mjs src/lib/strata/ownerShaRelease.test.ts
node artifacts/api-server/scripts/run-v13-disposable-postgres.mjs src/lib/strata/ownerSignedExchangeReleaseProof.test.ts
node artifacts/api-server/scripts/run-v13-disposable-postgres.mjs src/lib/strata/ownerSignedExchangeReleaseProof.postgres.test.ts
node artifacts/api-server/scripts/run-v13-disposable-postgres.mjs --restore
```
The renewal fixture is included in `test:v13-safety-all` and the fractional safety CI workflow. No production provider request, mutation, publication, migration or order was performed by this author.
