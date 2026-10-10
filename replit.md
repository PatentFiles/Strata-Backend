# BTC Paper Testing Dashboard

A phone-friendly, paper-only live dashboard that compares Coinbase BTC-USD spot movement with public Kalshi KXBTC15M market data.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run public market-data routes and protected history API
- `pnpm --filter @workspace/btc-paper-dashboard run dev` — run the dashboard
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Public Coinbase/Kalshi market data remains unauthenticated. Private history uses Clerk sessions and PostgreSQL; do not add Kalshi private credentials or order submission.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/btc-paper-dashboard/src/App.tsx` — phone-first dashboard UI
- `artifacts/btc-paper-dashboard/src/lib/marketData.ts` — Kalshi/Coinbase public feeds
- `artifacts/btc-paper-dashboard/src/lib/strategy.ts` — V1.3 Early-Bird paper strategy
- `artifacts/btc-paper-dashboard/src/lib/usePaperTrading.ts` — live market state and paper positions
- `artifacts/btc-paper-dashboard/src/lib/useHistoryStore.ts` — account-scoped server ledger, explicit legacy import, export, and sync status
- `artifacts/api-server/src/routes/history.ts` — authenticated account-scoped history API
- `artifacts/api-server/src/routes/kalshi.ts` — read-only server-side proxy for Kalshi REST data

## Architecture decisions

- Kalshi REST is proxied server-side because the public endpoint does not allow browser CORS.
- Coinbase BTC-USD is consumed directly from its unauthenticated public WebSocket feed.
- Saved paper and manual live-test history is account-scoped in PostgreSQL. Legacy browser history is only imported when the user chooses to do so, and is never deleted by import. Legacy browser backup JSON can bridge the preview and published origins, which have separate storage and accounts.

## Product

The dashboard detects the current KXBTC15M market, tracks BTC price and short-term velocity, evaluates the V1.3 Early-Bird rules, and records hypothetical $5 positions, exits, settlement outcomes, and server-derived cumulative results for signed-in users. The public market view remains accessible without sign-in.

## User preferences

- Keep the app paper-only. Never add live order submission or credential requirements.

## Gotchas

- Kalshi is read-only market data. If the public feed is unavailable, the model remains in WATCH rather than using fallback prices.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
