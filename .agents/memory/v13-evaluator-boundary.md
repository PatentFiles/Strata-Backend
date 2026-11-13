---
name: V1.3 evaluator boundary
description: Why the shared signal evaluator deliberately does not own feed synchronization or settlement.
---

The shared V1.3 evaluator classifies a coherent snapshot, including entry and open-position exit intent. It does not acquire market data, certify a snapshot as fresh, construct or persist paper positions, or settle their P&L.

**Why:** The extraction was deliberately limited to deterministic classification so the existing browser behavior, settlement precedence, and accounting stay unchanged. A future worker must not treat a signal classification as proof that its market/BTC observations are synchronized.

**How to apply:** Call the shared evaluator rather than reimplementing thresholds. Before calling it, pair a BTC observation with the intended market/target and reset crossing history when that market identity changes; retain independent position settlement and persistence handling.