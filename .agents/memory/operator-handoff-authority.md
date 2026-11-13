---
name: Operator handoff authority
description: Separating user-designated launch-champion metadata from locally verified engine identity and trading authority.
---

The user designated V1.3 C52/53 as the launch champion handoff. Displaying this handoff must not imply that the locally running evaluator has adopted it, that backend champion identity is proven, or that execution is enabled.

**Why:** The user requested a UI-only cleanup using locally available data, with no changes to trading authority, risk limits, credentials, schema, approvals, arming, funding, submission, cancellation, or reconciliation. The local implementation did not provide the newer champion identity or research interfaces.

**How to apply:** Keep handoff metadata separate from current evaluator observations. Show backend identity and research as unavailable until actual read-only backend data supports them. Preserve existing safety controls and clearly label browser/account paper history separately from the shared server paper ledger. Faster monitoring must not increase pending-write retry frequency.
