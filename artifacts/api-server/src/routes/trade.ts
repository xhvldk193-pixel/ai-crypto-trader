import { Router } from "express";
import { exchangeService, type PositionSide } from "../lib/exchange";
import { db } from "@workspace/db";
import { tradeHistoryTable, botConfigTable } from "@workspace/db";

const router = Router();

const ALLOWED_SIDES = ["BUY", "SELL"] as const;
const ALLOWED_TYPES = ["market", "limit"] as const;

router.post("/order", async (req, res) => {
  const body = req.body ?? {};
  const { symbol, side, type, quantity, price, positionSide, reduceOnly } = body;

  // ✅ 입력 검증 강화 — 타입/범위 모두 체크
  if (typeof symbol !== "string" || symbol.trim().length === 0) {
    res.status(400).json({ error: "symbol must be a non-empty string" }); return;
  }
  const sideUpper = typeof side === "string" ? side.toUpperCase() : "";
  if (!ALLOWED_SIDES.includes(sideUpper as typeof ALLOWED_SIDES[number])) {
    res.status(400).json({ error: "side must be 'BUY' or 'SELL'" }); return;
  }
  const typeLower = typeof type === "string" ? type.toLowerCase() : "";
  if (!ALLOWED_TYPES.includes(typeLower as typeof ALLOWED_TYPES[number])) {
    res.status(400).json({ error: "type must be 'market' or 'limit'" }); return;
  }
  const qtyNum = Number(quantity);
  if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
    res.status(400).json({ error: "quantity must be a positive finite number" }); return;
  }
  let priceNum: number | undefined;
  if (typeLower === "limit") {
    priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      res.status(400).json({ error: "price must be a positive finite number for limit orders" }); return;
    }
  }
  const ps: PositionSide | undefined =
    positionSide === "LONG" || positionSide === "SHORT" ? positionSide : undefined;

  try {
    const cfgRows = await db.select().from(botConfigTable).limit(1);
    const cfg = cfgRows[0];

    const order = await exchangeService.placeOrder(symbol, sideUpper, typeLower, qtyNum, priceNum, {
      positionSide: ps,
      reduceOnly: Boolean(reduceOnly),
      leverage: cfg?.leverage ?? 10,
      marginType: cfg?.marginType ?? "ISOLATED",
    });

    // ✅ 체결 가격: 거래소 응답 우선 → 실패 시 현재가로 폴백
    let fillPrice = Number.isFinite(order.price) && order.price > 0
      ? order.price
      : undefined;
    if (!fillPrice) {
      try {
        const ticker = await exchangeService.getTicker(symbol);
        fillPrice = ticker.price;
      } catch {
        fillPrice = priceNum ?? 0;
      }
    }

    // ✅ 체결 수량: 거래소 응답의 filled/amount 우선 → 요청 수량으로 폴백
    const filledQty =
      Number.isFinite(order.filled) && order.filled > 0 ? order.filled :
      Number.isFinite(order.quantity) && order.quantity > 0 ? order.quantity :
      qtyNum;

    await db.insert(tradeHistoryTable).values({
      symbol,
      side: sideUpper.toLowerCase(),
      price: fillPrice,
      quantity: filledQty,
      total: fillPrice * filledQty,
      fee: fillPrice * filledQty * 0.001,
      pnl: 0,
      triggeredBy: "manual",
      exchangeOrderId: order.id,
    });

    res.json(order);
  } catch (err) {
    req.log.error({ err }, "Failed to place order");
    const msg = err instanceof Error ? err.message : "Failed to place order";
    res.status(500).json({ error: msg });
  }
});

router.get("/orders", async (req, res) => {
  const symbol = typeof req.query.symbol === "string" ? req.query.symbol : undefined;
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
  const symbol = typeof req.query.symbol === "string" ? req.query.symbol.trim() : "";
  if (!orderId || orderId.trim().length === 0) {
    res.status(400).json({ error: "orderId required" }); return;
  }
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
