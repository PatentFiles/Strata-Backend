# Strata — Kalshi operator-pending fee PDF audit

This is a **read-only SHA-256 inspection**, not an alternative Kalshi receipt.

## Verified existing production object (October 15, 2026)
- Private bucket: `strata-official-fee-artifacts`
- Fixed pending path: `operator-pending/kalshi-fee-schedule.pdf`
- Storage metadata: `281129` bytes, `application/pdf`
- Known original local-file SHA-256: `c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601`
- Original document claimed official URL: `https://kalshi.com/docs/kalshi-fee-schedule.pdf`
- Published effective date: July 7, 2026.
- Existing `strata_official_fee_captures` ledger contains **zero** provider-verified rows.

## New read-only auditor
The JWT-protected Supabase Edge Function `strata-fee-pending-audit`:
1. Requires a signed-in, email-confirmed user whose email has the existing **ADMIN** role via `private.role_assignments`. Its identity check is a security-definer **boolean** RPC; it never returns role records.
2. Reads the **single fixed** object using server-side service-role credentials.
3. Computes SHA-256 from actual Storage bytes and checks PDF framing, size and digest.
4. Returns only checksum, metadata and explicit `canonicalOriginIndependentlyVerified: false`, `officialFeeApproved: false` and `tradingEnabled: false` facts.
5. Never writes a fee-capture record or adjusts policy, balance, permissions, signals, or execution controls.

The Edge endpoint must be called by an authorized authenticated reviewer, with their own access token; never paste tokens into an issue, conversation, screenshot or frontend source. The upload does not become current official evidence merely by passing hash inspection.

## Pending production approval design (NOT implemented by this PR)
An authorized operator-origin capture workflow requires: audited reviewer attestations of current Kalshi publication; independent confirmation; immutable reviewer identities and timestamps; versioned fee exceptions and target market applicability; bounded expiration; data-integrity/role checks; backend approval **and** commissioning using the same short-lived provenance identity. No capture or live-money authority may be forged by inserting a row or repurposing the existing provider-capture table.

If Kalshi continues returning HTTP 429, obtaining Kalshi-approved server access remains the stronger path. Do not change C52/C53 or bypass the current fee-approval gate to use this file.
