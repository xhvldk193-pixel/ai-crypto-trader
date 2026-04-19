import { Router } from "express";
import { exchangeService } from "../lib/exchange";
import { runBacktest } from "../lib/backtest";

const router = Router();

router.post("/run", async (req, res) => {
  const {
    symbol,
    timeframe = "15m",
    candleCount = 500,
    tradeAmountUsd = 100,
    stopLossPercent = 2,
    takeProfitPercent = 5,
    feePercent = 0.1,
    warmupBars = 60,
    windowBars = 100,
  } = req.body ?? {};

  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ error: "symbol required" });
    return;
  }

  const limit = Math.max(100, Math.min(1000, Number(candleCount) || 500));

  try {
    const candles = await exchangeService.getOhlcv(symbol, timeframe, limit);
    if (!candles || candles.length < Number(warmupBars) + 10) {
      res.status(400).json({ error: "Not enough candles for backtest" });
      return;
    }
    const result = runBacktest({
      symbol,
      timeframe,
      candles,
      tradeAmountUsd: Number(tradeAmountUsd),
      stopLossPercent: Number(stopLossPercent),
      takeProfitPercent: Number(takeProfitPercent),
      feePercent: Number(feePercent),
      warmupBars: Number(warmupBars),
      windowBars: Number(windowBars),
    });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Backtest failed");
    res.status(500).json({ error: "Backtest failed" });
  }
});

export default router;
