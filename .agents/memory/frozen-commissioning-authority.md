---
name: Frozen commissioning authority
description: Historical approval fields retained during dedicated-pair commissioning are not new execution authority.
---

An audit-linked, still-FROZEN commissioning successor is preparation only.
Retained historical arming/approval metadata preserves attribution; it must not
be interpreted as new authorization to place orders for the successor pair.

**Why:** The operator explicitly separated development reconciliation from live
execution approval and required historical evidence to remain intact.

**How to apply:** Keep commissioning review, applying the development transition,
fee approval, and live arming as separate authority boundaries. Mocked rollback
and eligibility tests are not evidence that real PostgreSQL constraints or live
exit/restart recovery have been proven.
