# Conditional book-first canonical quote candidate (local only)

Base: deployed 80b, verified source tree `c438d95b62145ea8431607579dbac05fa61588ca`.
This is quote fidelity and stricter modeled paper execution, **not a speedup or live-fill claim**. No production reads, migrations, provider requests, approvals, orders, or deployments were performed by this patch's validation.

## Behavior and boundaries

- A price-independent shared canonical structural predicate selects possible fresh SCOUT/CONFIRM entries. It retains the original BTC buffer, velocity, separation, direction, fresh-cross and entry-policy rules; it does not filter using the old detail ask or manufacture an offer.
- Flat, unconsumed, structurally eligible candidates acquire one public book outside every DB lease/strategy transaction. There is no every-cycle book poll. Paper-open exits/marks, consumed windows, noncandidate observations and closed markets do not perform this entry read. Existing live owned-exit/reconciliation paths are unchanged.
- Both asks, both bids and midpoint marks for the candidate come from one normalized public book. Binary asks are complements of maximum opposite bids, preserving fractional ticks. The original metadata payload remains separately labeled in source diagnostics. Entry-only preflight does **not** make later paper exits executable: open-paper marks/exits still use the existing detail source.
- The final lease/window/position-fenced transaction rechecks preview identity, actual current time, original BTC provider/receipt and detail acquisition ages, market closure and canonical classification. A missing book after a false-preview/true-final race aborts, never falls back to detail offers. Failed/unavailable/malformed/stale book reads create no BTC/window/evaluation/position mutation; diagnostic attempt/error records may change.
- Original cycle timestamps are never restamped. Header receipt and full-body completion are distinct. Every source age remains at most five seconds; final late bodies, market closure, backward clocks, shutdown or lease loss abort. The book read is capped by the existing 1.9s transport allowance AND the remaining original source/window budget; this does not extend quote validity.
- A valid but overpriced book commits the normal nonactionable observation and crossing history. It does not consume the crossing. Later same-side drift does not become a new crossing.
- **Stricter approved paper-action gate:** a valid SCOUT/CONFIRM classification/reference is retained, but action eligibility requires full whole-contract capacity using the existing configured $5 paper stake at that exact reference. One-short/fractional insufficient depth creates an explicit no-paper-fill reason, no position, no P&L and no crossing consumption. Normal observed cross history still advances. No higher/deeper reference, partial paper fill, price-cap widening or new slippage policy is introduced.

## Request budget / cooldown / evidence reuse

One GET maximum per structurally possible candidate cycle, including candidates later rejected for price/depth. Ordinary successful cycles keep the existing five-second cadence; failures keep the existing recovery cadence. Existing singleton public-book limiter and provider Retry-After/cooldown apply across independent attempts and recrosses; 429 aborts with no retry. A per-engine in-flight guard prevents overlapping preflights and has no quote cache/backlog. This bounds requests by candidate attempts, not by eventual fills; it is an explicit possible increase for rejected candidates compared with historical post-entry-only research reads. Existing account-wide signed LIVE budgets are untouched.

A successful paper ENTRY reuses the exact acquired book for optional post-commit research persistence—no duplicate GET and no restamped clocks. The receipt's JSON identifies `PRE_QUALIFICATION`, original times, canonical evaluation ID and evidence. EXIT keeps existing `POST_ACTION` behavior. Old receipts remain unchanged; legacy missing phase is still post-action. Research persistence can fail/be skipped and cannot authorize/retry an entry. Rejected candidates retain compact canonical provenance/capacity/digests but no separate full-ladder receipt, because existing research receipts are position-bound. The digest is not a claim that a missing research receipt exists.

## Additive schema and rollout / rollback

`sql/strata_forward_entry_book_quote.sql` adds exactly one nullable JSONB column,
`public.forward_test_evaluations.entry_quote_evidence`. It has no default, backfill, historical validation, new index or authority/control side effect. Existing rows stay NULL. The current research receipt capacity JSON gains optional fields and needs no table alteration.

The canonical column is necessary because provenance must commit atomically with the source decision, including rejected candidates that have no paper position; optional, position-bound research receipts cannot provide that authority. It contains version/source/purpose, exact ticker, original request/header/body times, four top prices, selected stake/whole-contract capacity summary, normalized-book/raw-response digests and a canonical evidence digest. No ladder, credential, raw HTTP body or account key is stored there. `evidenceDigest` uses the existing sorted-key canonical SHA256 helper and matches the separately reviewed mandatory LIVE guard.

The producer enforces compact JSON <=2048 UTF-8 bytes and bounded ticker/digests/levels/numbers. Actual disposable-PG fixtures measured 842–846 bytes `pg_column_size`, 748–754 JSON-text bytes, for qualifying and rejected capacity cases. A real raw-response digest adds roughly 60–70 bytes. Budget approximately 0.85–0.95 KiB per candidate plus row/index/WAL/storage overhead; 1,000 candidates are roughly 0.9 MiB of this column, not a forecast of candidate rate. Noncandidate rows remain NULL. A maximum-identity fixture tests the <=2KiB bound.

Required combined release order (not authorization to execute): independent patch review and combined tests; owner STOP/held; apply additive migration with 2s lock/10s statement timeout; verify column; deploy reviewed combined SHA including mandatory LIVE evidence validation; perform fresh SHA-scoped approvals and normal controlled acceptance only as separately authorized. The source/reference policy changes even though champion strategy caps/hash and crossing parameters do not. No old approvals are renewed by this patch.

Old runtime tolerates the extra nullable column and old receipts. Rollback runtime while held; **leave the additive column and receipt history in place**. Do not drop/backfill/relabel history. New runtime on old schema fails closed and rolls back strategy writes (tested); migrating before runtime avoids producer interruption. The combined mandatory LIVE guard rejects legacy/missing/inconsistent evidence for new entry authority; historical NULL records remain readable.

## Offline evidence and interpretation

The twelve known original qualifier snapshots were joined to their exact position/window/side public receipts. Independent full-ladder extraction confirmed sides, maxima, cents/ticks and fractional normalization; wire body/request URL was not retained. The delayed public snapshots are not same-time authenticated venue asks and cannot distinguish caching from repricing or prove a missed trade.

The actual unchanged canonical classifier reproduced all 12 original classifications. Replacing only both offers with later captured-book asks, keeping original BTC/velocity/target/time/cross inputs, yielded six SCOUT and six PASS:

- SCOUT: 48→48, 43→52, 45→49, 39→43, 36→52, 0.7→25 cents.
- PASS: 51→99, 51→65, 6.9→60, 52→57, 51→64, 6→59 cents.

Using the existing capacity model and $5 stake at the six revised references gave full modeled quantities respectively 10/10, 9/9, 10/10, 11/11, 9/9 and 20/20. This is delayed-book counterfactual evidence only, not executable liquidity, verified fees, order acceptance, profit or fill proof. No synthetic/forced signals or orders were used.

## Regressions and commands

Focused suite includes canonical 52/53-cent boundaries, missing detail repaired only by book, .007 and .069 paths, coherent quotes, original-clock/body/market expiry and clock regression, invalid/empty/crossed/duplicate books, shared real fetch 429 cooldown, no-read cases including consumed paper-closed windows, provider-await NOWAIT lock proof, preview races, lease loss, capacity exact-full/one-short/fractional/deeper-reference refusal, no unfilled P&L, no duplicate GET, and idempotent migration/old-schema rollback.

Use pinned pnpm9 and disposable loopback PostgreSQL17; tests have no production fallback:

```
PATH=/tmp/strata-bin:/tmp/strata-pg/usr/lib/postgresql/17/bin:$PATH pnpm --filter @workspace/api-server run test:entry-book-qualification
PATH=/tmp/strata-bin:$PATH pnpm --filter @workspace/api-server run test:producer-cadence
./node_modules/.bin/tsc -b lib/db lib/api-zod lib/v13-strategy
./node_modules/.bin/tsc -p artifacts/api-server/tsconfig.json --noEmit
PATH=/tmp/strata-bin:$PATH pnpm --filter @workspace/api-server run build
```

Existing worker and entry-policy integration fixtures use explicit offline books and clocks; production parsing is not weakened for tests. The canonical integrator runs one final sequential types/build/full safety suite after this patch and the independent LIVE guard are frozen. Focused author results alone are not full-release approval.

## Historical comparability and remaining qualification

This release changes the paper quote-source regime. Historical NULL/detail-priced paper results are not directly equivalent to new book-qualified paper entries; neither is an authenticated exchange fill. Preserve prior rows without backfill or relabeling, and do not automatically promote a learning challenger based on comparisons that mix those regimes. A qualifying classification with insufficient full stake capacity remains a recorded signal but cannot create a modeled paper fill, position, P&L or consumed crossing. The rollover safe-hold limitation remains: incomplete strike/scope/quote data must still reject or wait. This patch does not activate WS strike supplementation or prove the rollover gap eliminated.
