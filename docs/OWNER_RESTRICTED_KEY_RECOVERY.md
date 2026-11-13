# Wallets: self-service recovery for a deleted / incorrectly scoped Kalshi restricted key

**Purpose:** Fix `restricted_key_not_bound_to_subaccount_1` when the owner's
Strata execution account already exists. Kalshi's web key creation form may
not offer a subaccount selector. Do **not** recreate Subaccount 1 or ask for
the user's RSA private key.

## Backend contract (requires migration 0043)

All endpoints are under the existing AAL2-authenticated Strata owner routes.
No owner ID or PEM is accepted from the frontend. Each HTTP request must
include the logged-in owner's existing Supabase bearer token.

1. `POST /api/strata/me/credentials/recover-restricted/prepare`
   - Body: `{}`
   - Read-only exchange preflight; durable local preparation only.
   - Success: `{ok:true,reason:"recovery_prepared",attemptId:<uuid>,state:"prepared",exchangePostAttempted:false,plan:{name:"STRATA_V13_SUBACCOUNT_1",key_type:"rsa",scopes:["read","write::trade"],subaccount:1}}`.
2. Show a styled confirmation modal titled **Replace my incorrectly scoped Kalshi trading key**:
   - Target: **Existing Subaccount 1 / Exchange Index 2**.
   - Key: **RSA**, scopes **read + write::trade** only.
   - Doesn't delete Subaccount 1; doesn't change balances, positions, policy,
     stake, MFA, live execution or worker state.
   - Note: Kalshi will create **one new API key**; any attempt or uncertain
     response **must not be repeated** until independently reconciled.
   - Confirming button only after explicit owner confirmation.
3. `POST /api/strata/me/credentials/recover-restricted/execute`
   - Body: `{"attemptId":"<prepare result UUID>","confirmation":"GENERATE_RESTRICTED_KEY_FOR_MY_FROZEN_ACCOUNT"}`
   - The request must be sent **once**, never retried by fetch libraries,
     interceptors, frontend requests or the user.
   - Successful reason: `restricted_key_recovered_verified`; refresh
     `GET /api/strata/me/credentials` and `GET /api/strata/me/commissioning`
     to confirm Restricted Execution = Verified and Step 1 becomes eligible.
   - If `recovery_key_saved_verification_pending`, do the ordinary read-only
     Restricted Execution Verify action. Do **not** generate another key.
   - If `recovery_post_uncertain_or_rejected_no_retry`,
     `recovery_generation_response_invalid_no_retry`, or
     `recovery_storage_uncertain_no_retry`, show **Needs reconciliation**.
     Lock the submit button; surface attemptId to operators (not secrets).

## UI conditions

- Offer recovery only for a registered Restricted Execution role that is
  **unverified**, with a persisted Subaccount 1 execution account and
  `setupReason` indicating invalid/missing subaccount scope or permissions.
- Use `nextAuthorizedAction.action = prepare_frozen_restricted_key_recovery`
  returned by commissioning status to gate presentation.
- Do not route into the original one-shot `generate_api_key` operation whose
  historic completion is immutable.
- Do not call either POST from a React effect, polling, page mount,
  retry interceptor, or background worker.
- Reject sign-in sessions not satisfying Strata AAL2. Never display, log, or
  send Kalshi private keys through the browser.

## Engineering deployment verification

- CI: owner recovery tests, successful Vault-rebind simulation,
  existing credential lifecycle/store tests and full V13 diagnostics.
- Apply additive migration `lib/db/drizzle/0043_owner_restricted_key_recovery.sql`
  separately before enabling the frontend button. Confirm table exists.
- Deploy backend with verified Git SHA; coordinate restart with active live
  traders before deploying to Railway.
- Owner confirms prepare then execute; inspect only owner-scoped readiness.
  Ensure global live settings, other owners, workers, intents, position history,
  signed cash, and fee approvals are unchanged.
- If rollback needed, rollback backend code; preserve attempt and audit rows.
  Never replay an already attempted key-generation POST.
