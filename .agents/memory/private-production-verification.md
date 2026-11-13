---
name: Private production verification
description: How to interpret authentication results when verifying this project's private published deployment.
---

Replit's private-deployment gate and the app's Clerk session are separate authentication layers. A private-deployment access token can establish that published API routes respond, but it does not authenticate a user to the private history API. A browser synthetic-login helper may redirect to the development hostname instead of creating a production Clerk session; do not count that as a successful production login or infer that production Clerk is broken from the helper's redirect.

**Why:** Production market and unsigned-history routes were reachable through the outer gate, while the synthetic-login attempt switched to development. A real signed-in production session later succeeded on history write and readback.

**How to apply:** For production account-history checks, verify that the browser remains on the published hostname after sign-in and corroborate a diagnostic write with production request logs and a read-only production database query. Do not disclose or persist access-token values in notes.