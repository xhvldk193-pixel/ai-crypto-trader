import { Router } from "express";
import { exchangeService } from "../lib/exchange";
import { db } from "@workspace/db";
import { tradeHistoryTable, activePositionsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

const router = Router();

router.get("/active-positions", async (req, res) => {
  try {
    const rows = await db.select().from(activePositionsTable);
    const positions = await Promise.all(rows.map(async (r) => {
      let currentPrice = r.entryPrice;
      try {
        const t = await exchangeService.getTicker(r.symbol);
        currentPrice = t.price;
      } catch { /* keep entry price */ }
      const isLong = r.side === "long";
      const pnl = (currentPrice - r.entryPrice) * r.quantity * (isLong ? 1 : -1);
      const pnlPct = ((currentPrice - r.entryPrice) / r.entryPrice) * 100 * (isLong ? 1 : -1);
      return {
        id: String(r.id),
        symbol: r.symbol,
        side: r.side,
        entryPrice: r.entryPrice,
        currentPrice,
        quantity: r.quantity,
        takeProfit: r.takeProfit,
        stopLoss: r.stopLoss,
        expectedMovePercent: r.expectedMovePercent ?? null,
        aiConfidence: r.aiConfidence ?? null,
        aiReasoning: r.aiReasoning ?? null,
        triggeredBy: r.triggeredBy,
        unrealizedPnl: pnl,
        unrealizedPnlPercent: pnlPct,
        openedAt: r.openedAt.getTime(),
      };
    }));
    res.json({ positions });
  } catch (err) {
    req.log.error({ err }, "Failed to get active positions");
    res.status(500).json({ error: "Failed to get active positions" });
  }
});

router.get("/balance", async (req, res) => {
  try {
    const balance = await exchangeService.getBalance();
    res.json(balance);
  } catch (err) {
    req.log.error({ err }, "Failed to get balance");
    res.status(500).json({ error: "Failed to get balance" });
  }
});

router.get("/positions", async (req, res) => {
  try {
    const positions = await exchangeService.getPositions();
    res.json({ positions });
  } catch (err) {
    req.log.error({ err }, "Failed to get positions");
    res.status(500).json({ error: "Failed to get positions" });
  }
});

router.get("/history", async (req, res) => {
  const symbol = req.query.symbol as string | undefined;
  const limit = Math.min(parseInt((req.query.limit as string) || "50", 10), 100);
  try {
    const query = db.select().from(tradeHistoryTable).orderBy(desc(tradeHistoryTable.createdAt)).limit(limit);
    const rows = await query;
    const trades = rows.map((r) => ({
      id: String(r.id),
      symbol: r.symbol,
      side: r.side,
      price: r.price,
      quantity: r.quantity,
      total: r.total,
      fee: r.fee,
      pnl: r.pnl ?? 0,
      triggeredBy: r.triggeredBy,
      timestamp: r.createdAt.getTime(),
    })).filter((t) => !symbol || t.symbol === symbol);
    res.json({ trades });
  } catch (err) {
    req.log.error({ err }, "Failed to get trade history");
    res.status(500).json({ error: "Failed to get trade history" });
  }
});

router.get("/pnl-timeseries", async (req, res) => {
  const days = Math.min(parseInt((req.query.days as string) || "30", 10), 180);
  try {
    const sinceMs = Date.now() - days * 86400000;
    const trades = await db.select().from(tradeHistoryTable).orderBy(tradeHistoryTable.createdAt);
    const filtered = trades.filter((t) => t.createdAt.getTime() >= sinceMs && (t.pnl ?? 0) !== 0);

    // Cumulative PnL points (one per realized trade)
    let cum = 0;
    const cumulative = filtered.map((t) => {
      cum += t.pnl ?? 0;
      return { timestamp: t.createdAt.getTime(), cumulativePnl: cum, tradePnl: t.pnl ?? 0 };
    });

    // Daily aggregation: pnl, wins, total trades → win rate
    const dayMap = new Map<string, { pnl: number; wins: number; total: number; ts: number }>();
    for (const t of filtered) {
      const d = new Date(t.createdAt);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      const ts = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      const cur = dayMap.get(key) ?? { pnl: 0, wins: 0, total: 0, ts };
      cur.pnl += t.pnl ?? 0;
      cur.total += 1;
      if ((t.pnl ?? 0) > 0) cur.wins += 1;
      dayMap.set(key, cur);
    }
    const daily = Array.from(dayMap.values())
      .sort((a, b) => a.ts - b.ts)
      .map((d) => ({
        timestamp: d.ts,
        pnl: d.pnl,
        trades: d.total,
        winRate: d.total > 0 ? d.wins / d.total : 0,
      }));

    // Aggregate KPIs across the requested window
    const wins = filtered.filter((t) => (t.pnl ?? 0) > 0);
    const losses = filtered.filter((t) => (t.pnl ?? 0) < 0);
    const totalWin = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
    const avgWin = wins.length > 0 ? totalWin / wins.length : 0;
    const avgLoss = losses.length > 0 ? totalLoss / losses.length : 0;
    const winRate = filtered.length > 0 ? wins.length / filtered.length : 0;
    const avgRiskReward = avgLoss > 0 ? avgWin / avgLoss : 0;
    const bestDay = daily.reduce((b, d) => (b === null || d.pnl > b.pnl ? d : b), null as null | typeof daily[number]);
    const worstDay = daily.reduce((b, d) => (b === null || d.pnl < b.pnl ? d : b), null as null | typeof daily[number]);

    res.json({
      cumulative,
      daily,
      kpis: {
        totalTrades: filtered.length,
        winRate,
        avgRiskReward,
        totalPnl: cum,
        bestDayPnl: bestDay?.pnl ?? 0,
        bestDayTimestamp: bestDay?.timestamp ?? null,
        worstDayPnl: worstDay?.pnl ?? 0,
        worstDayTimestamp: worstDay?.timestamp ?? null,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Failed to compute PnL timeseries");
    res.status(500).json({ error: "Failed to compute PnL timeseries" });
  }
});

router.get("/summary", async (req, res) => {
  try {
    const balance = await exchangeService.getBalance();
    const trades = await db.select().from(tradeHistoryTable).orderBy(desc(tradeHistoryTable.createdAt)).limit(100);
    
    const pnlValues = trades.map((t) => t.pnl ?? 0);
    const totalPnl = pnlValues.reduce((acc, v) => acc + v, 0);
    const profitableTrades = pnlValues.filter((v) => v > 0).length;
    const totalTrades = trades.length;
    const winRate = totalTrades > 0 ? profitableTrades / totalTrades : 0;
    const bestTrade = pnlValues.length > 0 ? Math.max(...pnlValues) : 0;
    const worstTrade = pnlValues.length > 0 ? Math.min(...pnlValues) : 0;
    
    const dayTrades = trades.filter((t) => Date.now() - t.createdAt.getTime() < 86400000);
    const dayPnl = dayTrades.reduce((acc, t) => acc + (t.pnl ?? 0), 0);

    const totalValue = balance.totalUsd;
    const totalPnlPercent = totalValue > 0 ? (totalPnl / totalValue) * 100 : 0;
    const dayPnlPercent = totalValue > 0 ? (dayPnl / totalValue) * 100 : 0;

    res.json({
      totalValue,
      totalPnl,
      totalPnlPercent,
      dayPnl,
      dayPnlPercent,
      winRate,
      totalTrades,
      profitableTrades,
      bestTrade,
      worstTrade,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get portfolio summary");
    res.status(500).json({ error: "Failed to get portfolio summary" });
  }
});

export default router;
