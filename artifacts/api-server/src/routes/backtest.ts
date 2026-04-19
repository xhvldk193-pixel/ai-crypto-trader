import { Router } from "express";
import { exchangeService } from "../lib/exchange";
import { runBacktest } from "../lib/backtest";

const router = Router();

const TF_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

router.post("/run", async (req, res) => {
  const {
    symbol,
    timeframe = "15m",
    days = 30,
    initialCapital = 10_000,
    tradeAmount = 1_000,
    minConfidence = 0.6,
    takeProfitPercent = null,
    stopLossPercent = null,
    useAtrTargets = true,
    feePercent = 0.001,
  } = req.body ?? {};

  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ error: "symbol required" });
    return;
  }
  const tfMs = TF_MS[timeframe];
  if (!tfMs) {
    res.status(400).json({ error: `unsupported timeframe: ${timeframe}` });
    return;
  }

  const positiveFinite = (v: unknown, name: string): number | { error: string } => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return { error: `${name} must be a positive finite number` };
    return n;
  };
  const nonNegFinite = (v: unknown, name: string): number | { error: string } => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { error: `${name} must be a non-negative finite number` };
    return n;
  };
  const inRange = (v: unknown, name: string, min: number, max: number): number | { error: string } => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) return { error: `${name} must be between ${min} and ${max}` };
    return n;
  };
  const checks: Array<number | { error: string }> = [
    positiveFinite(initialCapital, "initialCapital"),
    positiveFinite(tradeAmount, "tradeAmount"),
    inRange(minConfidence, "minConfidence", 0, 1),
    nonNegFinite(feePercent, "feePercent"),
  ];
  for (const c of checks) {
    if (typeof c !== "number") {
      res.status(400).json({ error: c.error });
      return;
    }
  }
  if (takeProfitPercent !== null && takeProfitPercent !== undefined) {
    const n = Number(takeProfitPercent);
    if (!Number.isFinite(n) || n <= 0) {
      res.status(400).json({ error: "takeProfitPercent must be a positive finite number" });
      return;
    }
  }
  if (stopLossPercent !== null && stopLossPercent !== undefined) {
    const n = Number(stopLossPercent);
    if (!Number.isFinite(n) || n <= 0) {
      res.status(400).json({ error: "stopLossPercent must be a positive finite number" });
      return;
    }
  }

  const daysNum = Math.max(1, Math.min(180, Number(days)));
  if (!Number.isFinite(daysNum)) {
    res.status(400).json({ error: "days must be a finite number" });
    return;
  }
  const endMs = Date.now();
  const startMs = endMs - daysNum * 24 * 60 * 60 * 1000;
  // Guard against absurdly large fetches
  const maxCandles = Math.min(8000, Math.ceil((endMs - startMs) / tfMs) + 100);

  try {
    const candles = await exchangeService.getOhlcvRange(symbol, timeframe, startMs, endMs, maxCandles);
    if (candles.length < 80) {
      res.status(422).json({ error: `historical data insufficient (got ${candles.length} candles)` });
      return;
    }

    const result = runBacktest(candles, {
      symbol,
      timeframe,
      initialCapital: Number(initialCapital),
      tradeAmount: Number(tradeAmount),
      minConfidence: Number(minConfidence),
      takeProfitPercent: takeProfitPercent === null ? null : Number(takeProfitPercent),
      stopLossPercent: stopLossPercent === null ? null : Number(stopLossPercent),
      useAtrTargets: Boolean(useAtrTargets),
      feePercent: Number(feePercent),
    });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Backtest failed");
    res.status(500).json({ error: "Backtest failed" });
  }
});

export default router;
