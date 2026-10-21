# C52/C53 fee and protective-exit independent release assessment — 2026-10-21

**Classification: NON-AUTHORIZING SECURITY REVIEW PACK. No orders, transfers, fee grants, release approvals, or live flags are created by this change.**

## What is actually implemented on main before this PR

- PDF-free Step 6 diagnostics: `twoSourceFeeEvidence.ts`, `step6ApiFeeObservation`.
- Reviewed API fee policy: `apiFeePolicyReviewCandidate.ts`, `apiFeeRateReference.ts`, `apiFeeGrantEligibility.ts`, `apiFeeSourceStage.ts`, reviewed private rate review/grant/consent records, and `guardedReviewedApiFeeWire.ts`. This is **not equivalent to an already signed policy**.
- Protective exit: `ownerFeeEmergencyExitReserve.ts`, `ownerFeeEmergencyExitUnknownCommit.ts`, `ownerFeeEmergencyExitSignedDispatch.ts`, `ownerFeeEmergencyExitAuthenticatedRecovery.ts`, `ownerFeeEmergencyExitReconciliationCommit.ts`, startup/exact-SHA guards and production worker integration.
- The V2 signed order endpoint `POST /trade-api/v2/portfolio/events/orders` and its `reduce_only=true`, `immediate_or_cancel`, book-side `bid/ask`, fixed-point `count`/`price`, subaccount and exchange-index request fields agree with Kalshi's documented schema (reviewed 2026-10-21): https://docs.kalshi.com/api-reference/orders/create-order-v2 .
- These are code and schema findings, **not** real venue signed-POST certification or a security approver attestation.

## Independent observed production evidence (read-only SQL, 2026-10-21)

| Private table | Rows |
|---|---:|
| strata_api_fee_rate_reviews | 0 |
| strata_api_fee_source_grants | 0 |
| strata_api_fee_owner_consents | 0 |
| strata_owner_sha_approvals | 0 |
| strata_protective_exit_release | 1 (existence is not evidence of current approved status) |
| strata_emergency_exit_reservations | 0 |
| strata_protective_exit_reconciliations | 0 |

The private tables exist on Supabase; count alone does not establish approval validity or that deployed Railway code references this database. Production project was not accessible through the connected Railway identity as of inspection. GitHub CI may prove isolated tests; it cannot prove authenticated Kalshi exchange effects.

## Security defects fixed in this candidate

1. Explicit `STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE=true` required for **production START AND actual signed exit**. Previously the absent switch was accepted by both paths if a matching DB approval existed. A malformed or absent environment flag must never imply a production opt-in.
2. Historical reviewed API fee model for protective exit remains eligible after normal short-lived **grant expiry only**; **explicit grant revocation**, **owner consent revocation**, **rate reviewer revocation** or **rate review expiration** fails the source-proof SQL. Do not confuse an expired short-lived grant with deliberate revocation.
3. Regression tests for absent/malformed flag and SQL revocation/expiry predicates.

## Remaining release qualification (a human must independently verify)

### Fee-source authorization at Step 9, Step 11 and ORDER_ENTRY
- Obtain current effective **Kalshi-origin** quadratic coefficient, rounding/account debit granularity and all KXBTC15M exceptions, event overrides and future schedule. A series multiplier of 1 is **not** proof of the complete fee formula. Never reclassify a user-uploaded or historically reviewed PDF as provider-verified.
- Another authenticated administrator with actual reviewer authority must review the exact formula/version/digest and fixed-point test vectors; record the immutable service-issued review, grant and expiry in the existing private workflow. The owner separately consents to the identical grant/fee model.
- For each boundary, require fresh API market/event/series/scheduled-change evidence and the matching original grant/policy identity. Test 429, timeout, redirect, stale observation, wrong market/index, changed multiplier, fee increases, bad rounding and cancelled consents.
- Include available/spendable cash, worst-case entry+exit fees, fee-inclusive stake caps and pending fill/reservation accounting in real server-side order admission; a unit-tested fee bound is not proof of spendability.

### Protective-exit execution (issue #46)
- Independently review the signed V2 IOC transport, reservation/fence ordering, owner + subaccount1/index2 identity, exact market/side/position/price/fee and cash checks, DB transaction locks and race with STOP/KILL.
- Exercise **authenticated exchange-connected**, controlled 0/partial/full IOC, wrong subaccount, rejected post, HTTP 429/5xx, timeout, response lost after POST, duplicate invocation, service crash after UNKNOWN marker, restart reads, fee grant expiry/revocation, market halt and no-fill. Preserve UNKNOWN/no-retry when evidence is ambiguous.
- Demonstrate that a protective exit can reduce real exposure without opening/adding to inventory. Partial or 0 fill must be tracked as residual **real position**, never declared flat. Confirm immutable POST/GET/fill receipts and position/cash ledger reconciliation.
- Another authorized reviewer must document acceptance for the **exact backend SHA**; test authoring, GitHub CI green, and an AI report are not themselves an independent security signoff.

### Production rollout gates
1. Run exact-head test suites, verify SQL migration and RLS/advisor checks in isolated environment.
2. Obtain independent human code review and required genuine fee review/owner consent; no fabricated credentials/signatures.
3. Deploy backend on original Railway project; verify `/healthz`, `/api/strata/release`, backend SHA and live flags.
4. Brit publishes matching frontend; verify exact API compatibility.
5. Execute fresh authenticated read-only fee, subaccount1/index2 cash, open orders, fills, positions and full exchange reconciliation.
6. Only after approved code/protective release and real source/owner records: owner Step 12 ARM, then separately Step 13 START with an approved $5 pilot and stop-on-UNKNOWN monitoring.

**GO/NO-GO: NO-GO until all real exchange-connected and human-authorized evidence is present.**
