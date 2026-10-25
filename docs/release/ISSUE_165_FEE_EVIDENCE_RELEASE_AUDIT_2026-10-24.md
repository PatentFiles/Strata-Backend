# Issue #165: fee-evidence and controlled $5 production-release audit

**As of:** 2026-10-24 19:56 CDT / 2026-10-25 00:56 UTC  
**Scope:** Kalshi `KXBTC15M`, Exchange Index 2, Subaccount 1.  
**Deployment examined:** `5f3151efb2d5aebaff7c6c56b0e4de41bb375ca7` on existing Railway `terrific-embrace`, production `Strata-Backend`.  
**Decision:** **NO-GO**. This record contains third-party retrieval observations and engineering investigation, **not** independent human fee attestation, account authorization, release signature or trading permission.

## 1. Reproducible research: the first-party fee material exists

The **issuer's canonical PDF** `https://kalshi.com/docs/kalshi-fee-schedule.pdf` was retrieved at 2026-10-25 UTC through an *external* HTTP/PDF indexing route (not from the Railway/Supabase issuer-capture function). The response identified **HTTP 200, content-type application/pdf, 12 pages**, title `Fee Schedule for July 2026 - 7.7.26 Update`. Extracted content included:

- Standard immediate-match taker rule: `round up(M × 0.07 × C × P × (1 - P))`.
- Maker rule `round up(M × 0.0175 × C × P × (1 - P))`, default maker multiplier **0** unless otherwise stated.
- `P` is contract price in dollars; `C` is contracts; `M` is product multiplier, default **1** for taker.
- Fee + position cost are rounded up to a **centicent ($0.0001)** in the published schedule. This **is not equivalent** to blindly rounding every execution to $0.01 or asserting any actual exchange fill fee.
- A non-standard series schedule exists. KXBTC15M must be independently checked against **the complete applicable exception table**, market/event overrides, and later effective-date changes. The downloaded 12-page text was not individually attested by a human under their own credentials.
- No settlement fee is listed in this schedule. Crypto rails and third-party brokers/payment methods may add additional costs; those cannot be presumed zero.

Issuer **Trade API** external read-only observations (2026-10-25 UTC; *external* network, not owner-signed account):
- `GET https://external-api.kalshi.com/trade-api/v2/series/KXBTC15M` responded HTTP 200 with `fee_type: "quadratic"`, `fee_multiplier: 1`, `exchange_index: 2`, last series update `2026-10-21T18:45:48.794394Z`.
- `GET https://external-api.kalshi.com/trade-api/v2/series/fee_changes?series_ticker=KXBTC15M&show_historical=false` responded HTTP 200 with `series_fee_change_arr: []`.
- This is series-level evidence **only**. It cannot establish that every event has no override, that there are no event-level scheduled changes, that the PDF was captured by the trusted backend, or that an owner approved the terms.

**Critical distinction:** Public PDF discoverability proves that one third-party network can fetch Kalshi's published document. It does **not** prove authoritative issuer-request continuity from production and cannot be inserted into `strata_official_fee_captures` as a direct provider capture, or substituted for a signed administrator review. We did not obtain the original PDF bytes into the release pipeline or calculate a fresh exact-file SHA-256.

## 2. Why the last deployment did not fix the remaining 429

PRs #205 and #206 eliminated internal Railway-before-Supabase double requests and separated `provider`, `shared_cooldown`, and `backend_local` 429 causes. Production rollout `5f3151e` passed the Railway `/api/healthz` check. A later **genuine provider-origin 429** at 2026-10-25 00:06:56 UTC produced a shared retry deadline of 00:36:56 UTC. Backend deployment success does not guarantee access through Kalshi's CDN from the production egress IP. Periodic retries, header/user-agent spoofing, IP rotation to defeat controls, and replacing publisher proof with a cached third-party blob are not appropriate monetary evidence sources.

**Preferred channel:** Use the existing independently reviewed official Trade API V2 fee-source path for authorization, after a genuine independent technical ADMIN checks the complete *issuer* fee publication, applicable effective dates, exception table, and rounding. If Kalshi supplies an authenticated support statement or sanctioned stable fee-data endpoint, it can serve as the separate first-party rate publication for the real administrator's audit. If neither is available, request issuer guidance; continue NO-GO.

## 3. Existing implementation: reviewed API human workflow, already built

- `artifacts/api-server/src/lib/strata/apiFeeRateReference.ts`: documented conservative review vectors and fixed model decision digest. These are **not** self-authenticating fee approvals.
- `apiFeeHumanApprovals.ts`: the ADMIN must be different from the owner, verified against `auth.users` + `private.role_assignments`. The authenticated ADMIN manually verifies current issuer fee rate, rounding and exceptions; records a 100–1600-character auditable note and issuer proof source, and signs an exact rate-decision digest. Current review TTL: **2 hours**.
- After a fresh bounded first-party Trade API market observation, the same real ADMIN issues a scoped grant that lasts **at most 15 minutes**. The authenticated owner separately records consent. **No** fabricated reviewer, duplicate identity, service-role direct insert, or pre-populated approval record.
- `apiFeeGrantEligibility.ts` and `apiFeeSourceStage.ts`: verify grant, owner consent, distinct current ADMIN, fresh exact-market API, revocations and expiry. These only admit the candidate into later independent checks.
- `ownerApiFeePolicyMigration.ts`: existing **explicit AAL2 owner** migration pathway from the currently approved account fee policy. It requires STOP/DISARM, a legitimate current source grant, authenticated recent cash and flatness, transaction fences, and version/hash continuity. It is not safe to auto-migrate on this audit.
- `guardedReviewedApiFeeWire.ts`: final order-side fence independently revalidates account policy, grant, signer, kill and signed protective-exit release; it does **not** permit entry merely because ADMIN reviewed the published formula.
- `Wallets` frontend `ReviewedApiFeeSourcePanel` provides independent ADMIN rate review, grant issuance and owner consent controls; `OwnerApiFeeMigrationPanel` provides owner-confirmed migration. These existing flows are preferable to new authorization tables or an improvised manual fee override.

## 4. Live database and account verification

Read-only Supabase verification at 2026-10-25 00:56:39 UTC:
- Canonical PDF captures: **0**.
- Independently signed API monetary-rate reviews: **0**.
- API fee grants: **0**.
- Exact-SHA owner approvals: **0**.
- Current exact-SHA protective-exit qualifications: **0**.
- Earlier audit: no active protective releases; all **5** account kill switches remain ON.
- The execution-account owner has a unique commissioned Index 2/Subaccount 1 account, currently held with an account kill switch. Saved $5 stake and risk preset must be checked for this **exact owner**, not inferred from other accounts or historical records.
- Account cash reconciliation is **older than 15 minutes**. The persisted cash balance cannot be treated as a fresh signed Kalshi proof of spendable funds and flat exposure.
- Railway variable **names** do not include `STRATA_WALLET_V4_SIGNED_POST_ENABLED` or `STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE`. Their runtime gates are therefore not demonstrated enabled. Do not turn them on until release prerequisites and order-safety tests pass.

## 5. Ordered release runbook with hard acceptance tests

### A. Independent issuer-source review (no trade / no owner identity spoof)
1. Independently retrieve current full official PDF from `https://kalshi.com/docs/kalshi-fee-schedule.pdf` through an authorized first-party channel (or obtain an authentic Kalshi support confirmation). Verify TLS origin, final URL, complete unmodified 12-page content, current effective date, full exception schedule, exact formula and rounding. Record SHA-256, observed UTC timestamp and immutable evidence in the designated restricted audit workflow; reject stale/ambiguous/modified material.
2. Read live series **and** each target market and event including series/event fee-change endpoints. Require unambiguous `KXBTC15M`, open market, quadratic fee type and multiplier, all scheduled changes and overrides resolved for order lifetime. An empty *series* fee-change list alone is not proof that event-level changes are absent.
3. Independent confirmed ADMIN, **not the owner**, signs the existing reviewed-API technical attestation in Wallets, with genuine source and actual examination of the terms. Verify the review row exists and remains valid. Then issue a time-bounded grant using the legitimate ADMIN workflow.
4. The intended owner signs in with their own AAL2 session and explicitly consents to the exact grant. Verify grant/consent readbacks before policy migration. If any step fails, STOP rather than manually inserting SQL approval rows.

### B. Exchange-signed cash and exposure
5. With kill ON and account disarmed, perform owner-scoped Kalshi signed GET of `portfolio/balance`, orders, fills, positions and settlements for exact Index 2/Subaccount 1. Exhaust pagination including historical orders/fills; require authenticated target echo, no unknown intents or partial fills, no unexplained reserved cash, zero exposure before fee-policy migration, and fresh `reconciled_at` <= 15 minutes. Transactionally reconcile expected available cash and any fee debits; do not assume the stored $25 is current.
6. Preview and explicitly approve the versioned migration using `ownerApiFeePolicyMigration.ts`. Preserve previous policy and audit records, approved $5 stake, its bounded all-in cost and configured risk preset. Verify new policy ID/hash, grant and stage eligibility after the transaction. Do not migrate simply because a Step 6 read-only badge is green.

### C. Exact SHA protective exits and owner release
7. Run existing read-only protected-exit candidate preflight against real best bids and depth, IOC rejection, partial fills, canceled/UNKNOWN order state, re-entry/duplicate protection and signed exchange recovery. Required evidence must be derived from actual exchange responses; successful paper simulation is insufficient proof of live execution behavior.
8. Obtain independently authenticated technical protective-exit review and unexpired qualification bound to **the exact deployed commit** and intended account. Any CI/source SHA mismatch invalidates eligibility. Review signed release expiry and role separation.
9. With owner AAL2, perform owner-specific exact-SHA release only after all current provider/cash/exit fences pass. Verify authoritative readback. Review the owner-account identity before any action.

### D. Controlled $5 launch
10. Verify release flags, worker lease, kill-switch invariants, idempotency, credentials, risk caps and rollback. Enable approved runtime options **only after** proof checks. The owner deliberately ARM/STARTs; no automatic startup from audit scripts. Confirm first live acknowledgment, partial/full fill, fee, cash and unwind against Kalshi authoritative signed records. STOP immediately on fee mismatch, unexpected exposure, stale market/book, persistent 429 or unreconciled order intent.

**Acceptance definition:** Fresh complete issuer monetary evidence + independent ADMIN review + owner consent + current owned policy + signed cash and flat exposure + independently qualified reducing-only protective exit bound to running SHA + owner exact-SHA AAL2 release + bounded live entry checks. A green Step 6 badge, CI pass, source report, or public PDF scrape alone cannot meet that definition.

## 6. Non-actions and rollback discipline

This report is non-executable. No trades, transfers, credential disclosure, forged ADMIN approvals, policy migrations, disabling kill switches, changing runtime flags, staging new production services or direct issuer-capture DB writes were performed. Do not remove or rewrite historical financial records. Report and retain all evidence failures and exact retryAt, and keep live-money NO-GO until independently verified.
