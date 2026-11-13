# Kalshi DEMO signed GET — operator execution handoff

**Scope:** KALSHI DEMO ONLY. C52/C53 source/strategy untouched. This does not
authorize a live order, production credential reuse, production commissioning,
fee policy approval, or a protective-exit POST.

## Setup once (authorized operator)
1. Log into the **separate** [Kalshi Demo account](https://demo.kalshi.co),
   create a DEMO API credential, and obtain its dedicated key ID and PEM private
   key. A production key does not work against demo. Do not reuse any Strata
   production signer and never send the PEM by email or chat.
2. In the backend repository GitHub settings, create the `kalshi-demo`
   **Actions environment** and configure required authorized reviewer(s).
   Store encrypted environment secrets named
   `STRATA_DEMO_KALSHI_KEY_ID` and `STRATA_DEMO_KALSHI_PRIVATE_KEY_PEM`
   (full PEM including newlines). Never commit their values.
3. Confirm the operator action is being run from protected `main`, not an
   external pull request. The workflow is
   `.github/workflows/kalshi-demo-authenticated-get.yml`.
4. GitHub Actions → **Kalshi DEMO authenticated GET (manual, read only)**
   → Run workflow → branch `main`.
5. After the environment approval and job completes, record the exact backend
   commit, workflow run URL, HTTP status, time, and the redacted status record.

## What this proves
The runner issues **one** signed GET to exactly
`https://external-api.demo.kalshi.co/trade-api/v2/portfolio/balance`,
with redirects disabled and a 10-second timeout. A successful check
requires HTTP 200 and a parseable balance field. Output includes no keys,
signatures, raw response bodies, cash figures, or personally identifying
exchange account data.

A successful GET authenticates **only the demo key** to that demo API read.
It does not verify an IOC, duplicate avoidance, fills, order history,
account ownership in production, Step 6 fee source, Step 9 approval, or
Step 11 commissioning. Do not label it as a trade or source grant.

If the job prints `isolated_demo_secrets_not_configured`, the **demo**
secrets have not been provisioned. If it fails with 401, check the DEMO
key ID and PEM via the owner, never paste keys into logs. For 429/5xx or a
timeout, save the redacted failure and stop; the runner never retries.

## Before any authenticated DEMO signed IOC test
A separate independently reviewed transactionally fenced test dispatcher,
durable UNKNOWN-before-POST evidence, confirmed demo position, complete
exchange history and explicit operator approval are required. This read-only
workflow deliberately has **no POST** permission or code path.
