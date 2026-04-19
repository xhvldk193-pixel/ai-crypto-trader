import { Router } from "express";
import { db } from "@workspace/db";
import { botConfigTable, botLogsTable, tradeHistoryTable, tradeReflectionsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { botManager } from "../lib/botManager";

const router = Router();

router.get("/status", async (_req, res) => {
  const status = botManager.getStatus();
  res.json(status);
});

router.post("/start", async (_req, res) => {
  await botManager.start();
  res.json(botManager.getStatus());
});

router.post("/stop", async (_req, res) => {
  botManager.stop();
  res.json(botManager.getStatus());
});

router.get("/config", async (req, res) => {
  try {
    const rows = await db.select().from(botConfigTable).limit(1);
    if (rows.length === 0) {
      const [created] = await db.insert(botConfigTable).values({}).returning();
      res.json(configToResponse(created)); return;
    }
    res.json(configToResponse(rows[0]));
  } catch (err) {
    req.log.error({ err }, "Failed to get bot config");
    res.status(500).json({ error: "Failed to get bot config" });
  }
});

router.put("/config", async (req, res) => {
  try {
    const rows = await db.select().from(botConfigTable).limit(1);
    const body = req.body;
    const updateData: Record<string, unknown> = {};
    if (body.symbol !== undefined) updateData.symbol = body.symbol;
    if (body.watchSymbols !== undefined && Array.isArray(body.watchSymbols)) {
      const cleaned = (body.watchSymbols as unknown[])
        .filter((s): s is string => typeof s === "string" && s.length > 0);
      const unique = Array.from(new Set(cleaned));
      updateData.watchSymbols = unique.length > 0 ? unique : [body.symbol ?? "BTC/USDT"];
    }
    if (body.timeframe !== undefined) updateData.timeframe = body.timeframe;
    if (body.tradeAmount !== undefined) updateData.tradeAmount = body.tradeAmount;
    if (body.maxPositions !== undefined) updateData.maxPositions = body.maxPositions;
    if (body.stopLossPercent !== undefined) updateData.stopLossPercent = body.stopLossPercent;
    if (body.takeProfitPercent !== undefined) updateData.takeProfitPercent = body.takeProfitPercent;
    if (body.minConfidence !== undefined) updateData.minConfidence = body.minConfidence;
    if (body.enabledIndicators !== undefined) updateData.enabledIndicators = body.enabledIndicators;
    if (body.autoTrade !== undefined) updateData.autoTrade = body.autoTrade;
    if (body.useAiTargets !== undefined) updateData.useAiTargets = body.useAiTargets;
    if (body.checkIntervalSeconds !== undefined) updateData.checkIntervalSeconds = body.checkIntervalSeconds;
    if (body.maxDailyLossPercent !== undefined) updateData.maxDailyLossPercent = body.maxDailyLossPercent;
    if (body.useMtfFilter !== undefined) updateData.useMtfFilter = body.useMtfFilter;
    if (body.strictMtf !== undefined) updateData.strictMtf = body.strictMtf;
    if (body.mtfTimeframes !== undefined && Array.isArray(body.mtfTimeframes)) {
      const cleaned = (body.mtfTimeframes as unknown[])
        .filter((t): t is string => typeof t === "string" && t.length > 0);
      updateData.mtfTimeframes = Array.from(new Set(cleaned));
    }
    if (body.useFundingRate !== undefined) updateData.useFundingRate = body.useFundingRate;
    if (body.symbolOverrides !== undefined && body.symbolOverrides && typeof body.symbolOverrides === "object") {
      updateData.symbolOverrides = sanitizeSymbolOverrides(body.symbolOverrides as Record<string, unknown>);
    }
    updateData.updatedAt = new Date();

    let updated;
    if (rows.length === 0) {
      [updated] = await db.insert(botConfigTable).values(updateData).returning();
    } else {
      [updated] = await db.update(botConfigTable).set(updateData).returning();
    }
    
    // Restart bot with new config if running
    await botManager.reloadConfig();
    
    res.json(configToResponse(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to update bot config");
    res.status(500).json({ error: "Failed to update bot config" });
  }
});

router.get("/logs", async (req, res) => {
  const limit = Math.min(parseInt((req.query.limit as string) || "50", 10), 100);
  try {
    const logs = await db.select().from(botLogsTable).orderBy(desc(botLogsTable.createdAt)).limit(limit);
    res.json({
      logs: logs.map((l) => ({
        id: String(l.id),
        level: l.level,
        message: l.message,
        symbol: l.symbol,
        action: l.action,
        timestamp: l.createdAt.getTime(),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get bot logs");
    res.status(500).json({ error: "Failed to get bot logs" });
  }
});

router.get("/reflections", async (req, res) => {
  const limit = Math.min(parseInt((req.query.limit as string) || "20", 10), 100);
  try {
    const rows = await db.select().from(tradeReflectionsTable).orderBy(desc(tradeReflectionsTable.createdAt)).limit(limit);
    res.json({
      reflections: rows.map((r) => ({
        id: String(r.id),
        symbol: r.symbol,
        timeframe: r.timeframe,
        side: r.side,
        entryPrice: r.entryPrice,
        exitPrice: r.exitPrice,
        exitReason: r.exitReason,
        pnl: r.pnl,
        pnlPercent: r.pnlPercent,
        holdSeconds: r.holdSeconds,
        originalConfidence: r.originalConfidence,
        originalExpectedMovePercent: r.originalExpectedMovePercent,
        originalReasoning: r.originalReasoning,
        bullishCount: r.bullishCount,
        bearishCount: r.bearishCount,
        lessonText: r.lessonText,
        timestamp: r.createdAt.getTime(),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get reflections");
    res.status(500).json({ error: "Failed to get reflections" });
  }
});

function sanitizeSymbolOverrides(input: Record<string, unknown>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const numericKeys = ["tradeAmount", "minConfidence", "takeProfitPercent", "stopLossPercent"] as const;
  for (const [sym, raw] of Object.entries(input)) {
    if (!sym || typeof sym !== "string") continue;
    if (!raw || typeof raw !== "object") continue;
    const entry: Record<string, number> = {};
    const r = raw as Record<string, unknown>;
    for (const k of numericKeys) {
      const v = r[k];
      if (v === null || v === undefined || v === "") continue;
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) entry[k] = n;
    }
    if (Object.keys(entry).length > 0) out[sym] = entry;
  }
  return out;
}

function configToResponse(row: typeof botConfigTable.$inferSelect) {
  const watchSymbols = Array.isArray(row.watchSymbols) && row.watchSymbols.length > 0
    ? (row.watchSymbols as string[])
    : [row.symbol];
  return {
    symbol: row.symbol,
    watchSymbols,
    timeframe: row.timeframe,
    tradeAmount: row.tradeAmount,
    maxPositions: row.maxPositions,
    stopLossPercent: row.stopLossPercent,
    takeProfitPercent: row.takeProfitPercent,
    minConfidence: row.minConfidence,
    enabledIndicators: (row.enabledIndicators as string[]) ?? [],
    autoTrade: row.autoTrade,
    useAiTargets: row.useAiTargets,
    checkIntervalSeconds: row.checkIntervalSeconds,
    maxDailyLossPercent: row.maxDailyLossPercent,
    useMtfFilter: row.useMtfFilter,
    strictMtf: row.strictMtf,
    mtfTimeframes: (row.mtfTimeframes as string[]) ?? ["1h", "4h"],
    useFundingRate: row.useFundingRate,
    symbolOverrides: (row.symbolOverrides as Record<string, Record<string, number>>) ?? {},
  };
}

export default router;
