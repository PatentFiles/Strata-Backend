# Public discovery rollover comparison

Bounded public GET capture at 2026-10-29 00:45 UTC (October 28, 7:45 PM Central). No credentials or order endpoints were used. Requests included the no-cache headers emitted by Node fetch with cache=no-store.

The legacy status=open listing returned the prior closed contract while the close-time-bounded listing and exact contract detail exposed the active next contract. First captured fully populated strike and positive two-sided offers:

| Source | Received after boundary |
| --- | ---: |
| Legacy status=open list | 31.870 seconds |
| Close-time-bounded list, status omitted | 6.798 seconds |
| Exact detail | 6.798 seconds |

This is one observed rollover comparison, with 25 responses per source and approximately 2–4-second sampling through a research network path. It is not dense synchronized strategy replay, proof of a missed executable crossing, a live fill, or a universal latency guarantee. The strike was genuinely unavailable in early responses; missing values must remain a refusal.

The producer change uses list responses only to discover an eligible ticker and reads that exact contract again before using its strike/quotes. List prices/status are not current strategy inputs. Closed/future/mismatched detail is refused; explicit expired-position reads remain supported for settlement.

Official filter contract: https://docs.kalshi.com/api-reference/market/get-markets documents min_close_ts/max_close_ts with status omitted. Combining those bounds with status=open is unsupported.

observations.jsonl is the retained public response summary with request/receipt timestamps and selected cache headers. observe.py is the bounded one-time capture script and refuses to overwrite evidence after its capture window.
