/**
 * routes/listing.ts
 * 상장 프론트런 대시보드 제어 API
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { listingEventsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { listingMonitor } from "../lib/listingMonitor";
import {
  getConfig, updateConfig, getActiveTrades,
  startPositionMonitor, stopPositionMonitor,
  handleListingEvent,
} from "../lib/listingTrader";

const router = Router();

// GET /listing/status
router.get("/status", (_req, res) => {
  res.json({
    monitorRunning: listingMonitor.isRunning(),
    config: getConfig(),
    activeTrades: getActiveTrades().map(t => ({
      symbol: t.symbol,
      entryPrice: t.entryPrice,
      takeProfit: t.takeProfit,
      stopLoss: t.stopLoss,
      entryTime: t.entryTime,
      maxHoldMs: t.maxHoldMs,
      announcementTitle: t.announcementTitle,
    })),
  });
});

// POST /listing/start
router.post("/start", async (_req, res) => {
  try {
    listingMonitor.start();
    startPositionMonitor();
    res.json({ ok: true, message: "상장 모니터 시작됨 (10초마다 바이낸스 공지 폴링)" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /listing/stop
router.post("/stop", (_req, res) => {
  listingMonitor.stop();
  stopPositionMonitor();
  res.json({ ok: true, message: "상장 모니터 정지됨" });
});

// PUT /listing/config
router.put("/config", (req, res) => {
  const body = req.body ?? {};
  const update: Record<string, unknown> = {};

  if (body.enabled !== undefined) update.enabled = Boolean(body.enabled);

  const num = (key: string, min: number, max: number) => {
    const v = Number(body[key]);
    if (Number.isFinite(v) && v >= min && v <= max) update[key] = v;
  };
  num("tradeAmountUsdt", 1, 100_000);
  num("takeProfitPercent", 1, 500);
  num("stopLossPercent", 1, 50);
  num("maxHoldHours", 0.5, 72);
  num("leverage", 1, 10);        // 상장 특성상 최대 10배로 제한
  num("maxWaitSeconds", 10, 300);
  num("checkIntervalMs", 1000, 10_000);

  updateConfig(update as Parameters<typeof updateConfig>[0]);
  res.json({ ok: true, config: getConfig() });
});

// GET /listing/events — 상장 이력
router.get("/events", async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
  try {
    const events = await db
      .select()
      .from(listingEventsTable)
      .orderBy(desc(listingEventsTable.detectedAt))
      .limit(limit);
    res.json({ events });
  } catch (err) {
    req.log.error({ err }, "상장 이벤트 조회 실패");
    res.status(500).json({ error: "조회 실패" });
  }
});

// POST /listing/test — 수동 테스트
router.post("/test", async (req, res) => {
  const { symbol = "TEST/USDT", title = "[테스트] Binance Will List TEST" } = req.body ?? {};
  try {
    // 테스트는 enabled 체크 없이 강제 실행
    await handleListingEvent({
      symbol,
      baseAsset: symbol.split("/")[0],
      exchange: "Manual",
      title,
      url: "https://test.com",
      detectedAt: Date.now(),
    });
    res.json({ ok: true, message: `${symbol} 테스트 이벤트 발생` });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
