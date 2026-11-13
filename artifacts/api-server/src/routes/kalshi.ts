import { Router, type IRouter, type Response } from "express";

const router: IRouter = Router();
const KALSHI_API_BASE =
  "https://api.elections.kalshi.com/trade-api/v2/markets";

async function forwardKalshi(path: string, res: Response) {
  const response = await fetch(`${KALSHI_API_BASE}${path}`, {
    headers: { Accept: "application/json" },
  });
  const payload: unknown = await response.json();
  res.status(response.status).json(payload);
}

router.get("/kalshi/markets/open", async (_req, res) => {
  try {
    await forwardKalshi(
      "?series_ticker=KXBTC15M&status=open&limit=100",
      res,
    );
  } catch {
    res.status(502).json({ error: "Unable to reach Kalshi market data" });
  }
});

router.get("/kalshi/markets/:ticker", async (req, res) => {
  try {
    const response = await fetch(
      `${KALSHI_API_BASE}/${encodeURIComponent(req.params.ticker)}`,
      { headers: { Accept: "application/json" } },
    );
    const payload = (await response.json()) as {
      market?: unknown;
      markets?: unknown[];
    };
    const normalized = payload.market
      ? { markets: [payload.market] }
      : payload;
    res.status(response.status).json(normalized);
  } catch {
    res.status(502).json({ error: "Unable to reach Kalshi market data" });
  }
});

export default router;