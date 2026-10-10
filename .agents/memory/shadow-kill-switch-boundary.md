---
name: Shadow kill-switch boundary
description: Preserve the separation between simulation and real-money execution.
---

The manual kill switch is an execution guard, not a simulation guard. In SHADOW_LIVE, a genuine qualifying V1.3 trigger may be recorded as an idempotent proposed or blocked shadow order using read-only orderbook data while the switch stays ON. MICRO_LIVE and every real Kalshi mutation remain unavailable, and live execution remains disabled.

**Why:** Requiring the kill switch to be OFF for simulated proposals made it impossible to observe shadow behavior while maintaining the user's required real-money safety posture.

**How to apply:** Preserve the read-only Kalshi client boundary and distinct simulation checks. Never infer permission for real exchange mutations from the existence of a shadow proposal, including a risk-eligible one.

## Simulated risk accounting

Shadow eligibility must use its own capital, remaining balance, per-proposal stake, open-position cap, and worst-case loss reservation. It must not borrow account cash, live-money limits, or real PnL as an eligibility basis. A fresh orderbook offer must also stay within the V1.3 Scout/Confirm cap and must not exceed the entry offer that qualified the trigger.

**Why:** Future real-money limits intentionally remain at zero while development simulation needs a finite budget; coupling the two would either suppress observation or weaken the real-execution boundary. With no simulated fills or settlement, reserved stake is the conservative loss exposure, not realized loss.

**How to apply:** Keep shadow reservations atomic and idempotent. Treat simulated proposals as open for a conservative 15-minute window unless a proper simulated expiry/settlement lifecycle is added; do not silently reset spent capital on a restart.