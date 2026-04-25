import { logger } from "./logger";
import { db } from "@workspace/db";
import { listingEventsTable, tradeHistoryTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { exchangeService } from "./exchange";
import { notifyAlert } from "./telegram";
import type { ListingEvent } from "./listingMonitor";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export interface ListingTradeConfig {
  enabled: boolean;
  tradeAmountUsdt: number;
  takeProfitPercent: number;
  stopLossPercent: number;
  maxHoldHours: number;
  leverage: number;
  maxWaitSeconds: number;
  checkIntervalMs: number;
}

let config: ListingTradeConfig = {
  enabled: false,
  tradeAmountUsdt: 100,
  takeProfitPercent: 30,
  stopLossPercent: 10,
  maxHoldHours: 4,
  leverage: 2,
  maxWaitSeconds: 60,
  checkIntervalMs: 3000,
};

interface ActiveTrade {
  symbol: string;
  baseAsset: string;
  entryPrice: number;
  quantity: number;
  takeProfit: number;
  stopLoss: number;
  entryTime: number;
  maxHoldMs: number;
  dbId: number;
  announcementTitle: string;
}

const activeTrades = new Map<string, ActiveTrade>();
let monitorIntervalId: ReturnType<typeof setInterval> | null = null;

async function waitForBitget(symbol: string, maxWaitMs: number, checkIntervalMs: number) {
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const ticker = await exchangeService.getTicker(symbol);
      if (ticker.price > 0) return { available: true, price: ticker.price };
    } catch {}
    logger.info({ symbol, attempt }, "비트겟 상장 대기 중...");
    await sleep(checkIntervalMs);
  }
  return { available: false, price: 0 };
}

export async function handleListingEvent(event: ListingEvent) {
  if (!config.enabled) return;
  const { symbol, baseAsset, title } = event;
  if (activeTrades.has(symbol)) return;

  let dbId = 0;
  try {
    const rows = await db.update(listingEventsTable).set({ status: "processing" }).where(eq(listingEventsTable.symbol, symbol)).returning();
    dbId = rows[0]?.id ?? 0;
  } catch {}

  const { available, price: currentPrice } = await waitForBitget(symbol, config.maxWaitSeconds * 1000, config.checkIntervalMs);
  if (!available) {
    await db.update(listingEventsTable).set({ status: "skipped", note: "비트겟 미상장" }).where(eq(listingEventsTable.symbol, symbol)).catch(() => {});
    await notifyAlert("warning", `⚠️ 상장 감지됐지만 비트겟 미상장\n심볼: ${symbol}`, `listing-skip-${symbol}`);
    return;
  }

  const takeProfit = currentPrice * (1 + config.takeProfitPercent / 100);
  const stopLoss = currentPrice * (1 - config.stopLossPercent / 100);
  const quantity = (config.tradeAmountUsdt * config.leverage) / currentPrice;

  try {
    const order = await exchangeService.placeOrder(symbol, "BUY", "market", quantity, undefined, { positionSide: "LONG", leverage: config.leverage, marginType: "ISOLATED" });
    const fillPrice = Number.isFinite(order.price) && order.price > 0 ? order.price : currentPrice;
    const filledQty = Number.isFinite(order.filled) && order.filled > 0 ? order.filled : quantity;

    activeTrades.set(symbol, { symbol, baseAsset, entryPrice: fillPrice, quantity: filledQty, takeProfit: fillPrice * (1 + config.takeProfitPercent / 100), stopLoss: fillPrice * (1 - config.stopLossPercent / 100), entryTime: Date.now(), maxHoldMs: config.maxHoldHours * 3_600_000, dbId, announcementTitle: title });

    await db.update(listingEventsTable).set({ status: "entered", entryPrice: fillPrice, quantity: filledQty, takeProfit, stopLoss, isPaper: false, maxHoldHours: config.maxHoldHours, enteredAt: new Date() }).where(eq(listingEventsTable.symbol, symbol));
    await db.insert(tradeHistoryTable).values({ symbol, side: "buy", price: fillPrice, quantity: filledQty, total: config.tradeAmountUsdt, fee: config.tradeAmountUsdt * 0.001, pnl: 0, triggeredBy: "listing", exchangeOrderId: order.id });

    await notifyAlert("info", `🚀 상장 프론트런 진입\n심볼: ${symbol}\n진입가: $${fillPrice.toFixed(4)}\nTP: +${config.takeProfitPercent}% / SL: -${config.stopLossPercent}%`, `listing-entry-${symbol}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.update(listingEventsTable).set({ status: "failed", note: msg }).where(eq(listingEventsTable.symbol, symbol)).catch(() => {});
    await notifyAlert("error", `❌ 상장 트레이드 실패\n심볼: ${symbol}\n${msg}`, `listing-fail-${symbol}`);
  }
}

export async function checkActiveTrades() {
  for (const [symbol, trade] of activeTrades.entries()) {
    try {
      const { price } = await exchangeService.getTicker(symbol);
      const elapsed = Date.now() - trade.entryTime;
      const tpHit = price >= trade.takeProfit;
      const slHit = price <= trade.stopLoss;
      const timeOut = elapsed >= trade.maxHoldMs;
      if (!tpHit && !slHit && !timeOut) continue;
      const exitReason = tpHit ? "TP" : slHit ? "SL" : "TIME";
      const pnl = (price - trade.entryPrice) * trade.quantity;
      const pnlPct = ((price - trade.entryPrice) / trade.entryPrice) * 100;
      try { await exchangeService.placeOrder(symbol, "SELL", "market", trade.quantity, undefined, { positionSide: "LONG", reduceOnly: true }); } catch (err) { logger.error({ err, symbol }, "청산 실패"); continue; }
      await db.insert(tradeHistoryTable).values({ symbol, side: "sell", price, quantity: trade.quantity, total: price * trade.quantity, fee: price * trade.quantity * 0.001, pnl, triggeredBy: "listing" });
      await db.update(listingEventsTable).set({ status: "closed", exitPrice: price, exitReason, pnl, pnlPercent: pnlPct, closedAt: new Date() }).where(eq(listingEventsTable.id, trade.dbId));
      activeTrades.delete(symbol);
      const icon = tpHit ? "✅" : slHit ? "❌" : "⏰";
      await notifyAlert(tpHit ? "info" : "warning", `${icon} 상장 트레이드 청산 — ${exitReason}\n심볼: ${symbol}\n손익: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`, `listing-exit-${symbol}`);
    } catch (err) { logger.error({ err, symbol }, "트레이드 체크 오류"); }
  }
}

export function startPositionMonitor() {
  if (monitorIntervalId) return;
  monitorIntervalId = setInterval(checkActiveTrades, 30_000);
  if (typeof monitorIntervalId.unref === "function") monitorIntervalId.unref();
}

export function stopPositionMonitor() {
  if (monitorIntervalId) { clearInterval(monitorIntervalId); monitorIntervalId = null; }
}

export async function restoreFromDb() {
  try {
    const open = await db.select().from(listingEventsTable).where(eq(listingEventsTable.status, "entered"));
    for (const r of open) {
      if (!r.entryPrice || !r.quantity || !r.takeProfit || !r.stopLoss) continue;
      activeTrades.set(r.symbol, { symbol: r.symbol, baseAsset: r.baseAsset, entryPrice: r.entryPrice, quantity: r.quantity, takeProfit: r.takeProfit, stopLoss: r.stopLoss, entryTime: r.enteredAt?.getTime() ?? Date.now(), maxHoldMs: (r.maxHoldHours ?? 4) * 3_600_000, dbId: r.id, announcementTitle: r.title });
    }
  } catch (err) { logger.warn({ err }, "상장 트레이드 복원 실패"); }
}

export function getConfig() { return { ...config }; }
export function updateConfig(cfg: Partial<ListingTradeConfig>) { config = { ...config, ...cfg }; }
export function getActiveTrades() { return [...activeTrades.values()]; }
