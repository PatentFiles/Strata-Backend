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

## Independent-review option retired
Per the owner's explicit decision, new independent execution-review issuance is retired, not retained as a parallel optional UI path. `/review`, `/standing-review`, and the old finite `/authorize` API return HTTP410 with no database work. The two review-issuance services cannot create records. Existing immutable historical evidence and genuine revocation mechanisms remain; nothing is relabeled as owner consent. The owner-self approval workflow is the only new execution-review enrollment route. Monetary fee-model policy is separate and has not been forged or silently replaced.

`continuous-status.ownerSelfAvailable` is an account-scoped display hint, not authorization: it is true only for the server-configured exact authenticated owner/account pair.

The retired finite authorization service is also an unconditional no-DB refusal. Its former global enable/kill-clear, account enable/kill-clear, worker-lease reset, freeze-clear and finite approval insertion implementation has been removed, not merely hidden by routing. Read-only status/owner-scope checks and genuine signed technical qualification remain unchanged.
