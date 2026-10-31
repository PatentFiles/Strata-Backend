# Rollover strike evidence and candidate path

## What this patch proves

The existing exact-market read now emits at most three compact typed events per process/window: first unavailable strike or transport failure, unresolved after 30 seconds if still observed, and first valid strike. No database tables, raw response bodies, titles, credentials, URLs, or extra requests are retained. With 96 quarter-hour windows/day, the hard cap is 288 events/day/process; normal healthy windows emit one. Actual structured output size is tested. Per-request metadata is kept only in the current callback and contains status, request/header round-trip, HTTP Date/Age and parsed cache directives. These receipt timings do not establish exchange quote generation time or metadata publication time.

Field evidence preserves existing parser behavior and distinguishes absent, null, numeric, numeric string, and unparseable values. `ready` means only that the strike is valid for the selected current market. It is not executable-price readiness, a qualifying signal, live eligibility, an order, or a fill. `firstObservedOffsetMs` distinguishes a late process startup from observation beginning near the boundary. The optional diagnostics sink cannot rescue invalid data or change eligibility. The existing five-second live quote policy, ten-fast-retry budget, cooldowns, abort fencing, and serialized worker are unchanged.

## Measured limitation

At 03:45 UTC on October31, production had eleven invalid parsed-strike rejections, then its first valid new-window evaluation at03:45:15.874. There were20.008 seconds between valid evaluations. Old logs do not retain the raw rejected fields, so provider omission is not proven. The final normal five-second polling interval can contribute up to about four seconds of additional detection delay relative to one-second polling, not the entire twenty-second gap.

## Offline scheduling experiments

Run `node research/rollover-strike-20261031/replay.mjs`. All candidates use no more reads through30 seconds than current behavior and no cadence faster than one second. Under the requested hypothetical strike-ready times0,1,5,11,15,20,30 seconds:

- Current detects0,1,5,15,15,20,30.
- Spreading the same15 total reads detects0,1,5,12,15,20,30, but worsens availability at2,4,6,8 seconds. No dominance or empirical benefit is proven.
- Two-second polling through20 seconds detects0,2,6,12,16,20,30 and worsens several early cases.

The JSON contains request counts and hypothetical uniform availability statistics. Uniform sampling is a synthetic comparison, not Kalshi's actual publication distribution. No candidate schedule is activated by this patch.

## Best next candidate, not a proven live remedy

Official Kalshi lifecycle metadata updates may expose strike changes before the eventually-consistent REST read model. A separately tested pure reducer/shadow reader can investigate that path using the existing owner/account-bound credential, exact ticker/window matching, disconnect/gap invalidation, bounded storage, and no entry authority. A metadata event is never a current executable quote. Fresh REST/orderbook prices and the existing five-second limit remain required.

Combine reviewed diagnostic and default-off lifecycle-shadow work into one controlled candidate release rather than repeated approval-disrupting deployments. Do not deploy or restart while the current live session is running. A future maintenance must establish a flat/disarmed account and fresh release review before activation. No broader key or credential creation is implied.

## Production acceptance still required

After an approved controlled deployment, capture multiple actual rollovers at existing read cadence, including late strike and any throttle, and compare field states, receipt/provider/cache timing, detection delay and request count. If a shadow lifecycle transport is separately enabled, obtain actual authenticated handshake/subscription evidence, same-account credential binding, sequence/disconnect recovery and revocation behavior, then compare event-ready against REST-ready timestamps without orders. Only then choose an authoritative metadata integration or cadence adjustment. Prove fresh signal-to-decision/order traces separately. Diagnostics alone do not eliminate provider latency or guarantee fills/profitability.
