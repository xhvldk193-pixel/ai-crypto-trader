import { Router } from "express";
import { exchangeService } from "../lib/exchange";

const router = Router();

router.get("/symbols", async (req, res) => {
  try {
    const symbols = await exchangeService.getSymbols();
    res.json({ symbols });
  } catch (err) {
    req.log.error({ err }, "Failed to get symbols");
    res.status(500).json({ error: "Failed to get symbols" });
  }
});

router.get("/ticker", async (req, res) => {
  const symbol = req.query.symbol as string;
  if (!symbol) {
    res.status(400).json({ error: "symbol required" }); return;
  }
  try {
    const ticker = await exchangeService.getTicker(symbol);
    res.json(ticker);
  } catch (err) {
    req.log.error({ err }, "Failed to get ticker");
    res.status(500).json({ error: "Failed to get ticker" });
  }
});

router.get("/ohlcv", async (req, res) => {
  const symbol = req.query.symbol as string;
  const timeframe = (req.query.timeframe as string) || "1h";
  const limit = parseInt((req.query.limit as string) || "200", 10);
  if (!symbol) {
    res.status(400).json({ error: "symbol required" }); return;
  }
  try {
    const candles = await exchangeService.getOhlcv(symbol, timeframe, limit);
    res.json({ candles });
  } catch (err) {
    req.log.error({ err }, "Failed to get OHLCV");
    res.status(500).json({ error: "Failed to get OHLCV" });
  }
});

export default router;
