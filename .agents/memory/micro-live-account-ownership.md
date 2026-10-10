---
name: Micro-live account ownership
description: Distinct non-exclusive primary mode versus exclusive-control claims.
---

Treat complete current and archived order/fill pagination as necessary evidence, not sufficient proof of exclusive bot control. The user explicitly approved a **distinct bounded, non-exclusive primary-account mode** despite shared-account inventory and race risks. Do not require or falsely assert `exclusiveControlVerified` for that mode; keep exclusive mode's stricter ownership claim unchanged. Primary mode is not a guarantee of isolated inventory, unaffected exits, exact P&L after conflict, or an account-wide loss cap.

**Why:** Kalshi supports numbered subaccounts and subaccount-restricted API keys, but its documentation says the owner and every trade-enabled sub-user can act on all subaccounts; sub-user permissions are account-wide. A restricted key proves only that key's scope, not that the owner cannot mint another key or trade. The primary account can have unrelated historical and future activity. Even a fresh, complete pre-submission scan cannot fence another actor's order between a GET and a POST. The user accepted that limitation for the separate primary mode, not as evidence of exclusivity.

**How to apply:** For the distinct primary mode, preserve exact order/fill attribution, immutable account-mode binding after an attempt, freeze on missing or conflicting same-market evidence, mark unprovable accounting unresolved, and perform GET-only recovery with no DELETE. For exclusive mode, require independently enforceable control before claiming isolation; key metadata and clean account history alone are not enough. Never infer strict exclusivity from a bounded primary test or mocked fixtures.