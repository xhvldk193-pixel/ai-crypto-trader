import { Router } from "express";
import { db } from "@workspace/db";
import { botConfigTable, botLogsTable, tradeHistoryTable } from "@workspace/db";
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
    if (body.timeframe !== undefined) updateData.timeframe = body.timeframe;
    if (body.tradeAmount !== undefined) updateData.tradeAmount = body.tradeAmount;
    if (body.maxPositions !== undefined) updateData.maxPositions = body.maxPositions;
    if (body.stopLossPercent !== undefined) updateData.stopLossPercent = body.stopLossPercent;
    if (body.takeProfitPercent !== undefined) updateData.takeProfitPercent = body.takeProfitPercent;
    if (body.minConfidence !== undefined) updateData.minConfidence = body.minConfidence;
    if (body.enabledIndicators !== undefined) updateData.enabledIndicators = body.enabledIndicators;
    if (body.autoTrade !== undefined) updateData.autoTrade = body.autoTrade;
    if (body.checkIntervalSeconds !== undefined) updateData.checkIntervalSeconds = body.checkIntervalSeconds;
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

function configToResponse(row: typeof botConfigTable.$inferSelect) {
  return {
    symbol: row.symbol,
    timeframe: row.timeframe,
    tradeAmount: row.tradeAmount,
    maxPositions: row.maxPositions,
    stopLossPercent: row.stopLossPercent,
    takeProfitPercent: row.takeProfitPercent,
    minConfidence: row.minConfidence,
    enabledIndicators: (row.enabledIndicators as string[]) ?? [],
    autoTrade: row.autoTrade,
    checkIntervalSeconds: row.checkIntervalSeconds,
  };
}

export default router;
