---
name: Kalshi tier and grant divergence
description: An Advanced grant and effective Predictions usage tier can disagree in an immediate post-upgrade read.
---

Do not equate an API-usage-level upgrade's HTTP success or the presence of an `advanced` grant with effective Advanced tier. Report both the Predictions `usage_tier` and exchange-lane grants from authenticated limits GETs; do not retry an upgrade just because they disagree.

**Why:** A one-shot upgrade returned HTTP 201 and an immediate limits GET listed a manual Advanced event-contract grant, while the effective Predictions `usage_tier` still reported Basic.

**How to apply:** On upgrade verification, distinguish grant creation from effective tier activation. If they diverge, stop and report the discrepancy rather than claiming Advanced is confirmed or submitting another mutation.