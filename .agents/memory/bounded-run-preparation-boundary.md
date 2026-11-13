---
name: Bounded-run preparation boundary
description: Why a separately prepared higher-cap micro-live test must remain distinct from execution approval.
---

An audited successor slot may preserve an expired unused run and declare a larger modeled reservation cap without granting permission to arm it.

**Why:** Isolated mocked tests can establish local fee-inclusive entry, one-use exit, and frozen restart behavior, but cannot establish the exchange's actual reduce-only IOC outcomes, fill timing, or an operationally safe response to residual inventory after a partial exit. Requiring successful real-trade evidence *before* authorizing the very first bounded test is circular; that evidence can only be collected in the first authorized test.

**How to apply:** Treat preparation, arming, and actual execution as separate gates. Keep the higher-cap live arming barrier during review; first verify documented/demo semantics and any discovered software interoperability gaps, then offer a separately authorized, one-time $5 evidence-collection run with one entry, at most one exit, no replacements or uncertain retries, explicit human handling for residual inventory, and a permanent post-attempt freeze. Do not call that evidence proven in advance or mistake test authorization for general live clearance. A changed run cap must freeze all execution, including during an in-flight exchange scan, but never prevent authenticated GET-only recovery and attribution of late fills under frozen gates.

An unused frozen $5 preparation may be archived into another unarmed $5 preparation under the same empty-ledger and revoked-approval conditions as a $1 predecessor; this does not raise the risk ceiling or grant arming. **Why:** Otherwise an unused prepared slot becomes permanently stuck even though it never submitted or reserved an order. **How to apply:** Allow only the discrete $1 and $5 source caps for this transition, and do not interpret archival as permission to submit.