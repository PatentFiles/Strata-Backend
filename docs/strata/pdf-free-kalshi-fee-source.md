# PDF-free Kalshi fee-source path for Strata C52/C53

**Status:** Engineering implementation proposal and release-gate checklist. Not a policy approval, and **not** permission to trade or transfer cash.

## Why the current workflow is blocked

1. Step 6 GET `/api/strata/me/fees/preflight` formerly attempted `establishOfficialFeeDigest()` (Kalshi's `kalshi-fee-schedule.pdf`) before allowing a read-only Kalshi Trade API observation. Cloud 429 errors unnecessarily blocked an observation. **PR #76 switches Step 6 to API-first**, relying on the existing strict `probeCurrentKalshiFeeApi` and `step6ApiFeeObservation` checks, without downloading a PDF.
2. Step 9 **owner risk-policy approval** is more sensitive than Step 6: it still requires independently authorized fee-source identity. Both the direct official-PDF route and the current operator-attested alternative are bound to PDF digests and signed release records. A successful Step 6 API observation is not sufficient by itself, by design.
3. Step 10 is **local owner review of the minimum reduce-only exit limit price**, not fee provenance. Its UI permits local review without final approval. The backend can mark it approved **only as part of separately authorized Step 11 commissioning**, so the overall workflow appears held up by Step 9.

## Required replacement: a genuinely independent official-API fee policy source

Do **not** simply relabel a `feeEvidenceDigest` as `feeArtifactDigest`, supply a fabricated provider-PDF digest, downgrade independent reviewers, or set `policyApproved` true in a browser. Those are safety bypasses rather than fee verification.

Introduce a **separate versioned source type** such as `kalshi_trade_api_fee_policy_v1` (not `operator_attested_not_provider` and not `kalshi_pdf_provider`). Its immutable evidence must bind:

- The real issuer/source host `https://external-api.kalshi.com/trade-api/v2` and `KXBTC15M`, `exchangeIndex=2`.
- Exact series, selected market ticker, event ticker, verified observation time, market-close and settlement bounds.
- Fee type `quadratic`, multiplier `1`, explicit refusal of unknown event/market overrides, waivers and unverified scheduled changes through settlement.
- Canonicalized complete fields hashed into a digest that binds the **specific observation**; an API digest is never a PDF SHA-256.
- Independently reviewed formula-version digest, integer-arithmetic fee implementation and rounding test vectors, fee-inclusive entry AND protective-exit worst-case budget. The series `fee_type`/multiplier alone does **not** independently prove the entire monetary fee formula. Obtain a separately verifiable Kalshi publication/support confirmation or explicit conservative fee bounds and security signoff before allowing it to approve policy.
- Exact private service-side signed fee policy review record and its administrator identity. Preserve independent reviewer/owner separation from the current V1 policy unless a formal security review explicitly approves a versioned alternative. **Do not deploy incomplete draft PRs #75/#56.**
- Owner-specific affirmative consent, exact account identifier, exchange index, short validity window, complete revocation history, and independent server-side stage gates. No permissions via browser input.

## Architecture acceptance criteria

- **Step 6**: API-only live observation works when PDF egress is 429, even without any policy/grant. Result is 200 only on valid exchange API data; otherwise 409. No stored provider PDF evidence, automatic policy approval, movement of funds or order.
- **Step 9**: owner may save/view a risk policy draft independent of any PDF (already supported). A final policy approval can use the new **reviewed API-source identity** only after all review, fee-formula, owner consent, provenance, freshness, and server-side authorization requirements are satisfied. Keep V1 PDF/attestation approvals separate from V2 API-only approvals. Never reinterpret old V1 approvals as V2.
- **Step 10**: owner can review an explicitly chosen minimum protective exit price independently of the PDF or Step 9. UI states **locally reviewed, not approved** until Step 11. No output claims a guaranteed protective fill.
- **Step 11**: commissioning must revalidate exact owner/source identity, approved risk policy, reconciled cash, configured stake, protective-exit floor, fresh fee API result, and unresolved-order checks.
- **Step 13 / order-entry**: repeat exact market/order fee validation immediately before **each entry and protective exit**, including current fee overrides/changes and integer-rounded fee model. Fail closed on 429, API outage, stale source, unknown fee model, insufficient fee-inclusive edge, altered market/owner, changed fees, or revoked/expired grant.
- Keep GLOBAL/OWNER live execution disabled and kill switches ON until independently signed final release. Do not modify C52/C53 signals, subaccount funding, or withdrawal settings.

## Implementation surfaces (review before merging)

- New additive private migration for versioned `fee_api_source_reviews`, policy grants and owner consents (RLS, grants revoked from client roles, immutable review identity, per-owner uniqueness, expiry, audit/revocation and transaction fencing).
- New dedicated API-source validator and tests; **do not** overload `REVIEWED_FEE_DIGEST`, `operator_attested_fee_source_v1`, `reviewed_pdf_sha256` or `feeArtifactDigest`.
- `operatorFeeAuthorizationReadiness.ts`, `ownerFeeSourceStage.ts`, risk-policy approve handlers, commissioning and final order path must add a **discriminated source union**, with exhaustive per-source validation and strict owner/exchange/market identity.
- `walletCommissioningSteps.ts` and the Step 9/10 UI must distinguish `API observed`, `source independently reviewed`, `policy approved`, `exit locally reviewed`, and `account commissioned`.
- Preserve real event, series, market, override, scheduled-change and incomplete-list pagination refusal from `twoSourceFeeEvidence.ts`.

## Mandatory evidence for release

1. Independent code/security review; CI tests include malformed/exhausted API, old V1 PDF approval reuse, tampering, 429, race/replay, cross-owner, cross-market, stale/revoked records, fee increase, fee rounding at 1 micro-unit, limit-price and exit fee boundaries.
2. Prove the versioned fee calculation against Kalshi's actual charge examples and documented current fee basis, not merely from the API multiplier or a copied file hash.
3. Signed owner-specific staging proof for Step 6 and Step 9 with no funds/orders. A second independent reviewer documents source and rate-model approval where required.
4. Authorized exchange-connected IOC + protective-exit + restart/unknown reconciliation, DB identity, risk limits and separate owner activation signoff.

**Current PR #76 scope:** Step 6 PDF-free read-only verification only. The Step 9 API-source approval feature described here is **NOT implemented or released** by this document.
