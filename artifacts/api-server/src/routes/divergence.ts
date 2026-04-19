import { Router } from "express";
import { exchangeService } from "../lib/exchange";
import { analyzeDivergences } from "../lib/divergence";

const router = Router();

router.get("/analyze", async (req, res) => {
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
