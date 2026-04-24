import { Router, type Request, type Response } from "express";
import { exchangeService } from "../lib/exchange";
// ✅ 분석 로직은 lib/divergence.ts 한 곳에만 — 중복 제거
import { analyzeDivergences } from "../lib/divergence";

const router = Router();

// GET /divergence?symbol=BTC/USDT&timeframe=15m&limit=200
router.get("/", async (req: Request, res: Response) => {
  const { symbol, timeframe = "15m", limit } = req.query as {
    symbol: string;
    timeframe?: string;
    limit?: string;
  };

  if (!symbol || symbol.trim().length === 0) {
    res.status(400).json({ error: "symbol is required" });
    return;
  }

  const candleLimit = Math.min(Math.max(1, parseInt(limit ?? "200", 10) || 200), 500);

  try {
    const candles = await exchangeService.getOhlcv(symbol, timeframe, candleLimit);
    if (candles.length < 30) {
      res.status(422).json({ error: `Not enough candle data (got ${candles.length}, need at least 30)` });
      return;
    }
    const result = analyzeDivergences(candles, symbol, timeframe);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Divergence analysis failed");
    const msg = err instanceof Error ? err.message : "Divergence analysis failed";
    res.status(500).json({ error: msg });
  }
});

// GET /divergence/analyze (레거시 호환 — 같은 로직)
router.get("/analyze", async (req: Request, res: Response) => {
  const symbol = req.query.symbol as string;
  const timeframe = (req.query.timeframe as string) || "1h";
  if (!symbol) {
    res.status(400).json({ error: "symbol required" }); return;
  }
  try {
    const candles = await exchangeService.getOhlcv(symbol, timeframe, 200);
    const result = analyzeDivergences(candles, symbol, timeframe);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to analyze divergences");
    res.status(500).json({ error: "Failed to analyze divergences" });
  }
});

export default router;
