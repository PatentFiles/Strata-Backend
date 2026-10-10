# Threat Model

## Project Overview

BTC Paper Testing Dashboard — a phone-friendly, paper-only dashboard that compares
Coinbase BTC-USD spot movement with public Kalshi KXBTC15M market data. pnpm workspace
monorepo: an Express 5 API server (`artifacts/api-server`) acting as a read-only proxy
for Kalshi public market data, and a React/Vite frontend (`artifacts/btc-paper-dashboard`).
A `mockup-sandbox` design canvas is dev-only.

There is no authentication, no user accounts, no server-side persistence, no secrets,
no credentials, and no order-submission capability. Paper-trading history lives only in
the browser's localStorage and is never sent to a server.

## Assets

- **Public market data** — Kalshi and Coinbase feeds. Public, non-sensitive; low value.
- **Local paper-trading history** — stored in browser localStorage only; never leaves the
  client. No cross-user exposure surface.

There are no application secrets, user credentials, PII, or business-critical state to protect.

## Trust Boundaries

- **Browser to API server** — the frontend calls `/api/kalshi/*`. The server only proxies
  requests to a fixed Kalshi base URL and returns public data. No auth boundary exists
  because there is no protected data or action.
- **API server to Kalshi** — outbound `fetch` to a hardcoded base URL
  (`https://api.elections.kalshi.com/trade-api/v2/markets`). The `:ticker` param is passed
  through `encodeURIComponent`, and Express route params match a single path segment, so the
  destination host/path prefix is fixed (no SSRF or path traversal).
- **Browser to Coinbase** — direct unauthenticated public WebSocket feed.

## Scan Anchors

- Production entry points: `artifacts/api-server/src/routes/kalshi.ts` (proxy),
  `artifacts/api-server/src/routes/health.ts` (healthz), `artifacts/api-server/src/app.ts`.
- Frontend data layer: `artifacts/btc-paper-dashboard/src/lib/marketData.ts`,
  `strategy.ts`, `usePaperTrading.ts`.
- Dev-only / ignore unless proven reachable: `artifacts/mockup-sandbox/**`,
  `lib/db` (Drizzle schema; `db push` is dev-only and unused by the API server).
- No dangerous sinks present: no `child_process`/`exec`, no SQL usage in the server, no
  `dangerouslySetInnerHTML`/`eval`, no filesystem writes from request input, no secrets.

## Threat Categories

### Information Disclosure

The proxy returns only public Kalshi market data. `app.use(cors())` allows any origin, but
because the server exposes no credentials, cookies, or private data, permissive CORS carries
no meaningful confidentiality impact here. No stack traces or internal details are returned
(errors collapse to generic 502 JSON).

### Denial of Service

The proxy has no rate limiting and forwards each request to Kalshi. This is inherent to a
public unauthenticated proxy; impact is limited to upstream rate-limit exhaustion and is not
a distinct application vulnerability. Autoscale deployment mitigates local resource exhaustion.

### Server-Side Request Forgery (considered, not present)

The `:ticker` route interpolates only an `encodeURIComponent`-encoded single path segment onto
a hardcoded Kalshi base URL, so an attacker cannot redirect the outbound request to another host.

## Notes

This project has an intentionally tiny attack surface. Keep it paper-only: do not add auth,
credentials, live order submission, or server-side persistence without revisiting this model.
