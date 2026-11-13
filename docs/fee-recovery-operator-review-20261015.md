# Fee Evidence Recovery — October 15, 2026 (staged, NOT approved)

## Problem, observed production facts
- Steps 1–5, 7 and 8 are complete. Owner bot balance is $25.00, transfer reconciliation is completed.
- Canonical `https://kalshi.com/docs/kalshi-fee-schedule.pdf` returns HTTP 429 to Railway, Supabase Edge and GitHub-hosted CI, despite the official PDF being viewable with an ordinary browser.
- Private Storage contains `strata-official-fee-artifacts/operator-pending/kalshi-fee-schedule.pdf` (metadata 281129 bytes). The original owner-supplied PDF has SHA-256 `c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601`.
- Existing `strata-fee-pending-audit` (admin only) computes SHA-256 from Storage bytes, but has **not** been invoked under an authorized human ADMIN session. Storage metadata is not proof of its exact bytes.
- Original backend PDF fixture tests already assert the 12-page, July 7, 2026 fee schedule, the correct general formula and exception table, and reject modified text. A public web client observed the corresponding PDF today, but did not provide a cryptographically authenticated Kalshi binary download.
- The owner personal policy has not been approved, and live trading remains OFF with the kill switch ON.

## What this PR does (operator review, no approval)
- Adds a **service-only, RLS-protected, append-only log** of independently authenticated ADMIN review claims. All record fields are bound to one incident document and canonical public URL.
- Each human reviewer must explicitly affirm current canonical-browser source review, document edition, scope, general rate and exceptions, within 15 minutes of their recorded observation.
- Edge POST independently downloads the *single fixed* private object, validates size, PDF framing, SHA-256, administrator JWT/email and existing ADMIN role. It never accepts an arbitrary object path, URL or bytes from the caller.
- Reviews expire within two hours. At least two distinct reviewers are necessary for a candidate review, and these reviews are merely human source-claims, never a verified provider response.
- No function returns a verified Kalshi source capture, approves an owner policy, writes `strata_official_fee_captures`, or commissions/arms/starts trading.

## Remaining release gates
1. Read-only signed administrator session must invoke the existing `strata-fee-pending-audit` and produce the **actual private object SHA-256**. Reject mismatches.
2. Two distinct authenticated ADMIN reviewers must independently inspect the live canonical publication and submit explicit source claims; retain evidence references and timestamps. *This human process alone does not prove canonical byte equality.*
3. Conduct a separate security and compliance review of whether the incident-scoped reviewed-artifact route is sufficient for **commissioning only**. It must have a durable provenance identity, an immutable audit trail, a short expiry, and immediate revocation on any contrary official evidence. A fresh canonical fetch remains preferred and may require Kalshi-approved network access.
4. Only after an explicit reviewed release: build a different, clearly labeled `operator_attested` fee evidence path. Keep it distinct from automated `official/` captures; never forge `x-strata-canonical-source` or reclassify `operator-pending` as provider-verified.
5. Wire Steps 6, 9 and 11 to the same reviewed identity, preserving independent owner consent, and test refusal for missing reviewer, stale source observation, modified bytes, mismatched market exceptions, revoked/expired evidence, duplicate review, other owner, concurrent approval/expiry and restarted deployments.
6. Trace live order execution and prove **fresh authenticated Kalshi series/event fee metadata and scheduled fee changes** are mandatory at the final submit barrier. Commissioning-only attestation must never satisfy the live fee gate or release kill switches.
7. Verify staged deployment, published frontend, rollback, and no real orders before owner Arm/Start authorization.

## Do not confuse evidence layers
- Uploaded PDF checksum: establishes *exact bytes*, not Kalshi origin or freshness.
- Operator review claim: establishes which human stated having inspected Kalshi's current publication, not signed provider origin.
- Explicit commissioning attestation: prospective separate authorization permitting approved limits and account preparation; only after reviewed controls.
- Live order fee evidence: fresh authenticated market-specific metadata; cannot be replaced by PDF or operator review.

No production policy/fee control paths are modified by this PR.
