# Explicit owner standing authorization (candidate, not deployed)

This is a product-policy alternative to the separate machine-attestation candidate. It uses existing signed technical qualification and owner AAL2 authentication. No independent person, fabricated reviewer, or machine issuer is needed to record the owner's own standing execution authorization.

`OWNER_SELF_V1` stores `independent_reviewer_id = NULL` and the authenticated owner's UUID in `owner_authorizer_id`. Legacy `INDEPENDENT_V1` records retain distinct-reviewer requirements; existing rows are never converted. Account, exact deployed SHA, policy, qualification, confirmation and evidence digest remain bound and immutable. Review and grant modes must match at startup, renewal, entry and protective-exit checks. Fee-model/source authorization is unchanged.

## Candidate owner steps after verified deployment
1. Sign in with existing AAL2 authentication and select the commissioned account.
2. Complete existing signed technical qualification. It must be current, with no unresolved account freeze.
3. POST `/production/protective-release/owner-standing-review` with exactly `expectedSha`, `accountId`, `policyHash`, `qualificationId`, and confirmation `I_AUTHORIZE_OWNER_ONLY_STANDING_EXECUTION_FOR_THIS_EXACT_SHA_ACCOUNT_POLICY_V1`.
4. Complete existing exact-SHA owner authorization and continuous execution grant. This patch does not click ARM or START.
5. Complete existing readiness checks and manually ARM/START only when those checks succeed.

These are API integration steps, not a claim that the current dashboard exposes the new action. Frontend integration remains required. This change cannot clear unresolved accounting, UNKNOWN orders, incorrect credentials, unprotected exposure, fee-model authorization or access failures. An unknown commit response must be inspected before repeating the action.

## Deployment requirements
Apply `lib/db/owner-self-release/001_explicit_owner_authority.sql` in the controlled stopped-account deployment only after confirming actual prerequisite schema and permissions. The migration is deliberately not automatic. Verify old and new consumer compatibility, deployed SHA, owner UI, fresh exchange orders/positions, and account blockers before calling this live-ready. No production credentials or reads are used by these tests.

## Local verification
`bash artifacts/api-server/scripts/test-owner-self-release.sh` creates an isolated disposable PostgreSQL database on loopback port 55469. It applies the actual old grant migration and candidate owner-mode migration, then exercises owner review, grant, and eligibility with fixture evidence only. These fixtures are not production qualification. Focused unit tests cover authority-type confusion, foreign owner, malformed consent, unknown COMMIT, and final-entry mode selection.

## Account-only rollout and revocation
New owner-self review and grant enrollment is disabled unless server configuration contains one verified pair: `STRATA_OWNER_SELF_RELEASE_OWNER_ID` and `STRATA_OWNER_SELF_RELEASE_ACCOUNT_ID`. Both must exactly match the authenticated owner and requested account. These are server-owned deployment values, never request input; no values are assumed or provisioned by this draft.

The owner can revoke their own explicit review with AAL2 POST `/production/protective-release/owner-standing-review-revoke`, exactly `{expectedSha, accountId, reviewId, confirmation: "I_REVOKE_MY_OWNER_ONLY_STANDING_EXECUTION_REVIEW_V1"}`. Revocation remains available if enrollment configuration is removed. It affects that review, including downstream entry/exit review checks; it does not close positions, cancel orders or send STOP. Independent reviews cannot be revoked through this endpoint. `continuous-status.reviewQualificationId` identifies the exact qualification behind the active review, rather than the latest unrelated qualification, for uncertain-response readback.

The REVIEWED_API_V2 standing fee successor still requires its separate independently signed fee model. Existing owner-approved V3/V4 fee modes are not selected or altered by this patch. Actual account/provider compatibility must be verified before proposing a fee-mode change.

Removing enrollment configuration prevents new self reviews and grants; it does not silently revoke an existing durable grant or disable protective exits. Use explicit owner revocation/STOP controls when that is the intended action.

## Backward-compatible owner-self integration on current main

This integration preserves production's newer held-consent and reconciled-history
pathways from PR334. Historical INDEPENDENT_V1 reviewer/issuer APIs remain
available to already-enrolled accounts; no reviewer identity is rewritten or
fabricated. The owner-self path is a separate opt-in route guarded by the
server-configured exact owner/account pair and by real AAL2 qualification.

Unlike the earlier candidate, this integrated branch intentionally does not
retire historical finite-review API handlers or delete their implementation.
Their security, revocation, protective and financial safeguards remain intact.

**Known activation limitation:** Owner-self review can now record consent
for a **genuinely disabled, killed and disarmed** account or a properly
released/disarmed account, but only with current qualified signed evidence.
It does **not** change execution eligibility, worker leases, cash, policy or
account/global KILL. Continuous grant enrollment still requires separately
verified, released and enabled account scope. PR334's held-consent and
protected final release requirements remain separate. Do not mistake an
owner-self review receipt for signed final release or permission to Start.

Backend deployment also requires `lib/db/owner-self-release/001_explicit_owner_authority.sql`
before selecting owner-self mode and actual runtime row-lock role proof.
The DB migration is non-replay-idempotent: inspect successful outcome before
retrying. This branch never automatically applies schema or provisions
`STRATA_OWNER_SELF_RELEASE_OWNER_ID` / `STRATA_OWNER_SELF_RELEASE_ACCOUNT_ID`.

## Existing owner-only monetary alternative (requires actual verification)
The codebase already provides V3 owner evidence consent, owner fee authority issuance, and stopped-account policy migration. The new regression covers migration from a REVIEWED_API_V2 policy whose existing risk limits already match the approved $25-capital/$5-entry/20% preset. It preserves those limits and the five-second quote policy, and does not create or modify V2 reviewer/model/source-grant evidence or change global execution flags.

This is not permission to select V3 blindly. It requires actual current official monetary publication evidence plus exact-market provider evidence, explicit AAL2 owner evidence/authority/migration consent, exact prior policy identity, and signed flat/reconciled history. The existing V3 authority is bounded to 15 minutes, not the V2 durable standing/on-demand renewal model. Existing V4 owner consent instead requires a matching approved dynamic-fee policy. Neither alternative should be reported usable for this account until these actual prerequisites and desired operating duration are verified. No provider evidence is fabricated by the regression fixture.
