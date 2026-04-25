import { Router } from "express";
import { db } from "@workspace/db";
import { listingEventsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { listingMonitor } from "../lib/listingMonitor";
import { getConfig, updateConfig, getActiveTrades, startPositionMonitor, stopPositionMonitor, handleListingEvent } from "../lib/listingTrader";

const router = Router();

router.get("/status", (_req, res) => {
  res.json({ monitorRunning: listingMonitor.isRunning(), config: getConfig(), activeTrades: getActiveTrades() });
});

router.post("/start", async (_req, res) => {
  listingMonitor.start();
  startPositionMonitor();
  res.json({ ok: true });
});

router.post("/stop", (_req, res) => {
  listingMonitor.stop();
  stopPositionMonitor();
  res.json({ ok: true });
});

router.put("/config", (req, res) => {
  const body = req.body ?? {};
  const update: Record<string, unknown> = {};
  if (body.enabled !== undefined) update.enabled = Boolean(body.enabled);
  const num = (k: string, min: number, max: number) => {
    const v = Number(body[k]);
    if (Number.isFinite(v) && v >= min && v <= max) update[k] = v;
  };
  num("tradeAmountUsdt", 1, 100000);
  num("takeProfitPercent", 1, 500);
  num("stopLossPercent", 1, 50);
  num("maxHoldHours", 0.5, 72);
  num("leverage", 1, 10);
  num("maxWaitSeconds", 10, 300);
  num("checkIntervalMs", 1000, 10000);
  updateConfig(update as Parameters<typeof updateConfig>[0]);
  res.json({ ok: true, config: getConfig() });
});

router.get("/events", async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
  try {
    const events = await db.select().from(listingEventsTable).orderBy(desc(listingEventsTable.detectedAt)).limit(limit);
    res.json({ events });
  } catch { res.status(500).json({ error: "조회 실패" }); }
});

router.post("/test", async (req, res) => {
  const { symbol = "TEST/USDT", title = "[테스트] Binance Will List TEST" } = req.body ?? {};
  await handleListingEvent({ symbol, baseAsset: symbol.split("/")[0], exchange: "Manual", title, url: "https://test.com", detectedAt: Date.now() });
  res.json({ ok: true });
});

export default router;
