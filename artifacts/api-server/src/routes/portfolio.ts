import { Router } from "express";
import { exchangeService } from "../lib/exchange";
import { db } from "@workspace/db";
import { tradeHistoryTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

const router = Router();

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
