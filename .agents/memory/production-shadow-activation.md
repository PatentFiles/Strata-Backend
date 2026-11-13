---
name: Production shadow activation
description: Safety sequencing for activating the production shadow observer without touching paper-worker data.
---

Verify production credential-bearing GET account and orderbook reads while the production shadow observer is disabled; only after a successful published preflight should its separate opt-in flag be enabled. Production configuration writes belong to guarded application startup, not direct agent SQL or development-data copying. Keep the existing paper worker independently gated.

**Why:** A present key does not prove the production deployment can authenticate, and Replit's agent access to managed production data is read-only. Production environment changes require a new publish to take effect, so combining unverified preflight and budgeted activation into one release would skip the requested safety checkpoint.

**How to apply:** Confirm the published preflight result, schema constraints, absence or safety of any existing shadow config, and current paper lease before the separate activation publish. Never silently reset a pre-existing config or replenish already reserved simulated capital on restart.