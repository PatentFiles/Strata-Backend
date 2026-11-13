---
name: Index-2 credential isolation
description: Why the new pair key must remain distinct from historical and shared bot credentials.
---

The restricted key for the created-clean `(N=1, exchange_index=2)` pair needs a dedicated development secret pair and exact attempt-bound key ID. Do not replace the historical subaccount-1 restricted secrets or change the shared bot subaccount setting merely to make the new key pass an existing binder.

**Why:** A separate historical restricted key already exists for subaccount 1 on index 0, and the shared bot setting currently selects subaccount 0. Changing shared credentials or its selector could redirect unrelated existing flows while still failing to prove the new key's pair provenance. The owner explicitly reserved the one-time private-key handoff for their authenticated session.

**How to apply:** After the owner saves the new secrets, independently verify exact key ID, name, subaccount, and narrow scopes with the unrestricted verifier; use the dedicated key for a signed GET against `(1,2)` and bind only if its durable attempt and clean-boundary provenance match. Leave funding, execution, and historical credentials untouched.

For pre-handoff checks, distinguish public routing proof from owner-page rendering proof. An unauthenticated public GET can prove which handler received the request; a separate GET-only local harness with an injected owner identity and the actual development database can verify the page, but it is not a real owner Clerk login through the public proxy.

**Why:** The agent does not have the owner's session, and the one-shot generation POST must remain entirely owner-controlled. A local listener must be ready before its ephemeral port can be used for the GET check; otherwise the harness fails without testing the page.

**How to apply:** Report the two verification surfaces separately, and never interpret an injected-identity GET as permission to submit the form or as evidence that the owner completed the handoff.

The owner confirmed that a real authenticated Safari session could open the new owner page after signing in on the same development hostname and using the signed-in dashboard link. This is evidence for that session, not a guarantee about later sessions or a substitute for separately checking the durable handoff.

**Why:** Before this confirmation, only an unauthenticated public route and an injected-identity GET had been checked; neither proved the real Safari Clerk path.

**How to apply:** Keep this confirmed navigation distinct from credential metadata, saved-secret matching, and durable confirmation or binding, each of which needs its own evidence.

Saving new Replit Secrets can restart the development API between the one-time secret display and the owner's acknowledgement. A confirmation that depends only on in-memory handoff state can then fail even though the key and its durable issuance record remain valid.

**Why:** The owner reported pressing the acknowledgement after saving the new Secrets, but a later read showed verified metadata with no persisted acknowledgement. The old form had no post-restart recovery path.

**How to apply:** For an already-issued credential, let the authenticated owner regain a fresh session-bound confirmation form from the durable attempt, while retaining exact same-origin/CSRF checks and independently re-verifying the saved key and clean pair. Never retry key creation to repair acknowledgement.