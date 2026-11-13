---
name: Development proxy origin
description: Observed proxy-header behavior relevant to strict development-only same-origin checks
---

The Replit public development proxy was observed preserving the externally visible hostname in `Host`, omitting `X-Forwarded-Host`, and supplying `X-Forwarded-Proto: https`. This observation came from a header-only request through the public development URL, not from the user's Safari session; do not claim it proves the exact values Safari sent.

**Why:** A single combined Origin/Host failure label cannot distinguish mismatched Origin, Host, protocol, or Fetch Metadata. Inferring an internal rewritten Host solely from a failed label would have led to an unsupported security change.

**How to apply:** For protected browser forms, compare exact Origin to the platform-provided canonical external HTTPS hostname and verify request host/proto separately. If a browser-specific failure remains, gather sanitized owner-visible request metadata rather than logging credentials or relaxing checks speculatively.

For navigation-mode HTML form POSTs, Fetch may serialize `Origin` as the literal `null` when the source page sets `Referrer-Policy: no-referrer`; it does not necessarily omit the header. The platform's proxy Host and HTTPS headers can be correct while the browser-origin check still fails.

**Why:** A redacted “invalid” display merged an opaque `null` Origin with malformed values. This made a browser privacy-policy effect look like a proxy mismatch.

**How to apply:** Distinguish absent, opaque-null, and malformed Origin values without echoing malformed input. Prefer a source-page `Referrer-Policy: same-origin` for a same-origin form when strict Origin validation is required; do not treat Fetch Metadata alone as a substitute for Origin.

The owner confirmed in Safari that, after the form page used `Referrer-Policy: same-origin`, its Origin was serialized HTTPS, exactly matched the canonical development origin, and every dry-run check passed.

**Why:** This browser observation validates the narrow source-page policy change without relying on a missing/opaque Origin fallback.

**How to apply:** Keep the exact Origin/Host/HTTPS check for this flow. Do not restore acceptance of `Origin: null` based on Fetch Metadata alone.

In local Node HTTP route tests, `fetch` did not honor a supplied `Host` header when the target was a loopback URL; the server saw the loopback host with its port. `node:http.request` did preserve the explicit Host header. This is a test-client behavior, not evidence that the Replit proxy rewrites Host.

**Why:** A valid owner request appeared to fail the same-origin check even after the nonce had been renewed. Inspecting only the CSRF response initially obscured the actual mismatch.

**How to apply:** For host-scoped route tests, send POSTs with `node:http.request` and explicitly set Host, Origin, and the forwarded HTTPS protocol. Test proxy behavior through the public development URL separately.