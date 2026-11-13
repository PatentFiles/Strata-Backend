---
name: Micro-live intent boundary
description: Why paper-only events cannot authorize live position actions, and the approved live evaluation boundary.
---

Treat a persisted paper entry as a candidate live entry only after independent live-risk checks. Do not infer a live Confirm add or exit merely from paper state. The user explicitly approved re-running the unchanged shared V1.3 algorithm on the reconciled actual live position, with recent paper-cycle feed evidence, and persisting a separate provenance-linked live evaluation. Keep automatic live submissions off until that contract and its restart behavior are proven end to end.

**Why:** The paper worker's first-cross and open-position state drive which V1.3 events it persists. Real fills may be partial, late, rejected, or absent, so the paper position can diverge. Reusing its EXIT or Confirm event as an unqualified live command could create an unjustified real order. A distinct evaluation is acceptable only because it uses the same shared strategy on the actual reconciled position, not a new trading rule.

**How to apply:** Preserve paper/shadow behavior. Require a provenance-linked live evaluation for post-fill Confirm or EXIT, prove side/crossing/position identity from actual orders and fills, and fail closed on stale or incomplete feed evidence. The shared classifier does not mark EXIT as a qualifying entry trigger; an actual open live position must additionally prove EXIT eligibility. Reconcile exchange orders, fills, cash, and position before an action, and keep the execution gates off when proof is missing.