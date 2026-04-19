import { Router } from "express";
import { exchangeService, type PositionSide } from "../lib/exchange";
import { db } from "@workspace/db";
import { tradeHistoryTable, botConfigTable } from "@workspace/db";

const router = Router();

router.post("/order", async (req, res) => {
  const { symbol, side, type, quantity, price, positionSide, reduceOnly } = req.body;
  if (!symbol || !side || !type || !quantity) {
    res.status(400).json({ error: "symbol, side, type, quantity required" }); return;
  }
  try {
    const cfgRows = await db.select().from(botConfigTable).limit(1);
    const cfg = cfgRows[0];
    const ps: PositionSide | undefined =
      positionSide === "LONG" || positionSide === "SHORT" ? positionSide : undefined;
    const order = await exchangeService.placeOrder(symbol, side, type, quantity, price, {
      positionSide: ps,
      reduceOnly: Boolean(reduceOnly),
      leverage: cfg?.leverage ?? 10,
      marginType: cfg?.marginType ?? "ISOLATED",
    });
    
    // Record in trade history
    const ticker = await exchangeService.getTicker(symbol);
    const fillPrice = order.price ?? ticker.price;
    await db.insert(tradeHistoryTable).values({
      symbol,
      side,
      price: fillPrice,
      quantity,
      total: fillPrice * quantity,
      fee: fillPrice * quantity * 0.001,
      pnl: 0,
      triggeredBy: "manual",
      exchangeOrderId: order.id,
    });
    
    res.json(order);
  } catch (err) {
    req.log.error({ err }, "Failed to place order");
    res.status(500).json({ error: "Failed to place order" });
  }
});

router.get("/orders", async (req, res) => {
  const symbol = req.query.symbol as string | undefined;
  try {
    const orders = await exchangeService.getOpenOrders(symbol);
    res.json({ orders });
  } catch (err) {
    req.log.error({ err }, "Failed to get orders");
    res.status(500).json({ error: "Failed to get orders" });
  }
});

router.delete("/orders/:orderId", async (req, res) => {
  const { orderId } = req.params;
  const symbol = req.query.symbol as string;
  if (!symbol) {
    res.status(400).json({ error: "symbol required" }); return;
  }
  try {
    await exchangeService.cancelOrder(orderId, symbol);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to cancel order");
    res.status(500).json({ error: "Failed to cancel order" });
  }
});

export default router;
