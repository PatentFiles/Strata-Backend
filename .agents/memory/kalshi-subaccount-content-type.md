---
name: Kalshi subaccount Content-Type requirement
description: A zero-byte create-subaccount POST succeeded with JSON Content-Type after a headerless one was rejected.
---

Do not infer from an optional JSON request body that Kalshi's create-subaccount endpoint accepts a bodyless POST without `Content-Type`. For an independently authorized zero-byte request, explicitly supply `Content-Type: application/json` while leaving the body absent.

**Why:** A single authorized bodyless create attempt without `Content-Type` returned HTTP 400 `invalid_content_type` and created nothing. A later, separately authorized request with the same zero-byte body and an explicit JSON Content-Type returned HTTP 201 and a numbered subaccount.

**How to apply:** Treat each one-POST authorization as final. For any future separately authorized creation, inspect the current schema and preserve the explicit JSON header/body decision; never silently retry after a rejection.