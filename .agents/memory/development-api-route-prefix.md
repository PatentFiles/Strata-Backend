---
name: Development API route prefix
description: Public development proxy behavior for API paths versus artifact-preview-prefixed paths
---

On the observed public development host, the root-level API route returned the API's unauthenticated 401 with no redirect, while the same path nested under the web artifact's preview prefix returned Vite HTML and could render the frontend's own 404. This does not prove which URL a particular Safari session requested.

**Why:** A browser report of the frontend's "Did you forget to add the page to the router?" 404 looked like a missing server handler even though the public root-level API route was reachable. Localhost-only checks would not have resolved the ambiguity.

**How to apply:** Test the complete public development URL (hostname and path) through the external proxy and compare response headers/body to both artifact-prefixed and root paths. Ask for the browser's actual address-bar URL if a direct full URL still behaves differently; do not change owner auth or add an API recovery form to the React router.