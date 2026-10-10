# Strata commissioning

Supabase-authenticated checklist for the reviewed V13 production pair `(subaccount 1, exchange index 2)`.

`GET /api/strata/commissioning/status` is the source of truth. `DEVELOPER` and `ADMIN` need an AAL2 Supabase JWT. `STANDARD` receives 403. A missing or AAL1 token receives 401.

Commissioning creates at most one account and leaves `executionEnabled` false and `killSwitch` true. It does not start ProductionWorker. `POST /api/strata/production/start` is a separate operation. Database arming still does not place an order, and the worker stays blocked until Railway itself has:

`NODE_ENV`, `LIVE_EXECUTION_ENABLED`, `V13_PRODUCTION_EXECUTION_ENABLED`, `KALSHI_API_ENVIRONMENT`, `MICRO_LIVE_ACCOUNT_MODE`, `KALSHI_BOT_SUBACCOUNT`.

| Step | Route | Rule |
| --- | --- | --- |
| Signer | `POST /api/strata/commissioning/verify-signer` | Signed GETs only. The restricted INDEX2 key cannot list key inventory, so `KALSHI_VERIFIER_API_KEY_ID` and `KALSHI_VERIFIER_API_PRIVATE_KEY` are required to GET `/trade-api/v2/api_keys` and prove the INDEX2 key is subaccount 1 with scopes `read` and `write::trade`. The INDEX2 key then signs GET `/portfolio/balance`. No key is generated. |
| Clean boundary | `POST /api/strata/commissioning/capture-boundary` | Read-only Kalshi evidence. Inserts one row only when subaccount 1, exchange index 2, authenticated history, and zero positions, orders, fills, settlements, and unexplained transfers are proven. A dirty pair is blocked and history is not erased. |
| Funding | `POST /api/strata/commissioning/fund` | Exact phrase `AUTHORIZE_ONE_SHOT_25_USD_TRANSFER`. One $25.00 transfer from subaccount 0 to subaccount 1 on exchange index 2. The attempt row commits before the single POST. An uncertain result never retries. |
| Reconcile | `POST /api/strata/commissioning/funding/reconcile` | GET-only. Never transfers. |
| Fee | `POST /api/strata/commissioning/verify-fee` | Official Kalshi fee PDF only. Policy `micro-live-standing-fee-policy-v1`, formula `standard-quadratic-0.07-v1`. Verified only after the reviewed parser accepts the file and its byte hash matches. |
| Cash | `POST /api/strata/commissioning/verify-cash` | Exact integer micros from an authenticated balance read. A caller cannot set the flag. |
| Policy | `POST /api/strata/commissioning/policy/propose` and `/policy/approve` | Operator supplies the seven limit fields. No defaults. Approval binds V1.3 champion `v13-champion-2-c52-confirm53` and hash `314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161`, then recomputes the policy hash. |
| Exit floor | `POST /api/strata/commissioning/minimum-exit/approve` | No reviewed derivation exists. The field is the reduce-only IOC minimum price in micros, range 1..999999. Phrase `APPROVE_MINIMUM_EXIT_FLOOR`. Source `operator_approved`. |
| Commission | `POST /api/strata/commissioning/commission` | Phrase `COMMISSION_WITHOUT_EXECUTION`. The request cannot supply a fingerprint, digest, cash, or execution flag. |
| Arm | `POST /api/strata/commissioning/arm` | Phrase `ARM_V13_PRODUCTION`. Sets `execution_enabled` true and `kill_switch` false only. Does not commission, start the worker, or change environment variables. |
| Disarm | `POST /api/strata/commissioning/disarm` | Phrase `DISARM_V13_PRODUCTION`. Sets execution off and the kill switch on. Refuses while an owned position or unresolved intent exists. This is not emergency stop. |

`kalshiConnectionStatus` is `NOT_CONFIGURED`, `VERIFYING`, `BLOCKED`, `READY_TO_COMMISSION`, `COMMISSIONED_DISARMED`, `READY_TO_START`, or `RUNNING`. `READY_TO_START` also requires the Railway transport gates and a stopped worker. `RUNNING` requires the ProductionWorker timer to be scheduled.

Read-only verification secrets: `KALSHI_INDEX2_API_KEY_ID`, `KALSHI_INDEX2_PRIVATE_KEY`, `KALSHI_VERIFIER_API_KEY_ID`, `KALSHI_VERIFIER_API_PRIVATE_KEY`.

Legacy `/api/admin/index2-*` routes keep their development, Replit, same-origin, and Clerk gates.
