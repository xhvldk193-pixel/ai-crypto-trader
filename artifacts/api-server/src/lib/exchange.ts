/**
 * exchange.ts — ccxt 기반 거래소 서비스 (Bitget 기본, 환경변수로 교체 가능)
 *
 * 환경변수:
 *   EXCHANGE_ID        = "bitget" | "binance" | "bybit" 등 (기본: "bitget")
 *   EXCHANGE_API_KEY   = API 키
 *   EXCHANGE_SECRET    = API 시크릿
 *   EXCHANGE_PASSWORD  = 패스프레이즈 (비트겟 필수)
 *   EXCHANGE_LIVE_MODE = "true" 이면 실거래, 그 외 데모
 */

import ccxt, { Exchange } from "ccxt";
import { logger } from "./logger";

const EXCHANGE_ID = (process.env.EXCHANGE_ID ?? "bitget").toLowerCase();
const API_KEY = process.env.EXCHANGE_API_KEY;
const SECRET = process.env.EXCHANGE_SECRET;
const PASSWORD = process.env.EXCHANGE_PASSWORD; // 비트겟 패스프레이즈
const IS_DEMO =
  !API_KEY || !SECRET || process.env.EXCHANGE_LIVE_MODE !== "true";

export type PositionSide = "LONG" | "SHORT";

export interface PlaceOrderOpts {
  positionSide?: PositionSide;
  reduceOnly?: boolean;
  leverage?: number;
  marginType?: string;
}

// ─── ccxt 인스턴스 생성 ───────────────────────────────────────────────────────

function createExchange(): Exchange {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExchangeClass = (ccxt as any)[EXCHANGE_ID];
  if (!ExchangeClass) throw new Error(`지원하지 않는 거래소: ${EXCHANGE_ID}`);

  const options: Record<string, unknown> = {
    apiKey: API_KEY ?? "",
    secret: SECRET ?? "",
    options: { defaultType: "swap" }, // 선물/영구계약
  };
  if (PASSWORD) options.password = PASSWORD;

  const ex: Exchange = new ExchangeClass(options);

  // 비트겟: 헤지 모드 활성화 옵션
  if (EXCHANGE_ID === "bitget") {
    ex.options["positionMode"] = "hedged";
  }

  return ex;
}

const ex = createExchange();

// ─── 심볼 변환 ───────────────────────────────────────────────────────────────
// ccxt는 "BTC/USDT:USDT" 형식 (linear perpetual)
function toSwapSymbol(symbol: string): string {
  if (symbol.includes(":")) return symbol;
  const base = symbol.replace("/", "").replace("USDT", "");
  return `${base}/USDT:USDT`;
}

// ─── 레버리지 / 마진 설정 캐시 ───────────────────────────────────────────────
const configuredSymbols = new Map<string, { leverage: number; marginType: string }>();

async function ensureSymbolSetup(
  symbol: string,
  leverage: number,
  marginType: string,
): Promise<void> {
  if (IS_DEMO) return;
  const cached = configuredSymbols.get(symbol);
  if (cached?.leverage === leverage && cached?.marginType === marginType) return;

  const swapSym = toSwapSymbol(symbol);

  try {
    await ex.setMarginMode(marginType.toLowerCase(), swapSym);
  } catch (err) {
    logger.warn({ err: String(err), symbol }, "setMarginMode 실패 (이미 설정됐을 수 있음)");
  }

  try {
    await ex.setLeverage(leverage, swapSym);
  } catch (err) {
    logger.warn({ err: String(err), symbol, leverage }, "setLeverage 실패");
    throw err;
  }

  configuredSymbols.set(symbol, { leverage, marginType });
}

// ─── Demo 상태 ───────────────────────────────────────────────────────────────
let demoWallet = 10000;
let demoOrderCounter = 1;
const demoPositions: Array<{
  symbol: string; side: "long" | "short"; entryPrice: number;
  currentPrice: number; quantity: number; pnl: number; pnlPercent: number; openedAt: number;
}> = [];
const demoOrders: Array<{
  id: string; symbol: string; side: string; type: string;
  status: string; price: number; quantity: number; filled: number; timestamp: number;
}> = [];

// ─── 공개 시세 ───────────────────────────────────────────────────────────────
async function fetchPublicTicker(symbol: string) {
  const swapSym = toSwapSymbol(symbol);
  const ticker = await ex.fetchTicker(swapSym);
  return {
    symbol,
    price: ticker.last ?? ticker.close ?? 0,
    change24h: ticker.change ?? 0,
    changePercent24h: ticker.percentage ?? 0,
    volume24h: ticker.quoteVolume ?? ticker.baseVolume ?? 0,
    high24h: ticker.high ?? 0,
    low24h: ticker.low ?? 0,
    timestamp: ticker.timestamp ?? Date.now(),
  };
}

// ─── 캔들 ────────────────────────────────────────────────────────────────────
type Candle = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };

async function fetchOhlcv(symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
  const swapSym = toSwapSymbol(symbol);
  const data = await ex.fetchOHLCV(swapSym, timeframe, undefined, limit);
  return data.map((k) => ({
    timestamp: k[0] as number,
    open: k[1] as number,
    high: k[2] as number,
    low: k[3] as number,
    close: k[4] as number,
    volume: k[5] as number,
  }));
}

async function fetchOhlcvRange(
  symbol: string, timeframe: string, startMs: number, endMs: number, maxCandles = 5000,
): Promise<Candle[]> {
  const swapSym = toSwapSymbol(symbol);
  const all: Candle[] = [];
  let since = startMs;
  const PAGE = 1000;

  while (since < endMs && all.length < maxCandles) {
    const data = await ex.fetchOHLCV(swapSym, timeframe, since, PAGE);
    if (!data || data.length === 0) break;
    for (const k of data) {
      if ((k[0] as number) > endMs) break;
      all.push({
        timestamp: k[0] as number,
        open: k[1] as number,
        high: k[2] as number,
        low: k[3] as number,
        close: k[4] as number,
        volume: k[5] as number,
      });
      if (all.length >= maxCandles) break;
    }
    const lastTs = data[data.length - 1][0] as number;
    if (data.length < PAGE) break;
    since = lastTs + 1;
  }
  return all;
}

// ─── 펀딩비 / 오픈 인터레스트 ────────────────────────────────────────────────
async function fetchFundingRate(symbol: string): Promise<number | null> {
  try {
    const swapSym = toSwapSymbol(symbol);
    const data = await ex.fetchFundingRate(swapSym);
    const v = data?.fundingRate ?? null;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch (err) {
    logger.warn({ err: String(err), symbol }, "펀딩비 조회 실패");
    return null;
  }
}

async function fetchOpenInterest(symbol: string): Promise<number | null> {
  try {
    const swapSym = toSwapSymbol(symbol);
    const data = await ex.fetchOpenInterest(swapSym);
    const v = data?.openInterestAmount ?? data?.openInterest ?? null;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch (err) {
    logger.warn({ err: String(err), symbol }, "오픈 인터레스트 조회 실패");
    return null;
  }
}

// ─── exchangeService ─────────────────────────────────────────────────────────
export const exchangeService = {
  isDemo: IS_DEMO,

  async getSymbols(): Promise<string[]> {
    try {
      await ex.loadMarkets();
      return Object.keys(ex.markets)
        .filter((s) => s.endsWith("/USDT:USDT"))
        .slice(0, 50)
        .map((s) => s.replace(":USDT", ""));
    } catch {
      return ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT"];
    }
  },

  async getTicker(symbol: string) {
    return fetchPublicTicker(symbol);
  },

  async getOhlcv(symbol: string, timeframe: string, limit: number) {
    return fetchOhlcv(symbol, timeframe, limit);
  },

  async getOhlcvRange(symbol: string, timeframe: string, startMs: number, endMs: number, maxCandles = 5000) {
    return fetchOhlcvRange(symbol, timeframe, startMs, endMs, maxCandles);
  },

  async getFundingRate(symbol: string) { return fetchFundingRate(symbol); },
  async getOpenInterest(symbol: string) { return fetchOpenInterest(symbol); },

  async getBalance() {
    if (IS_DEMO) {
      const positionValue = demoPositions.reduce((s, p) => s + p.pnl, 0);
      return {
        totalUsd: demoWallet + positionValue,
        balances: [{ asset: "USDT", free: demoWallet, locked: 0, usdValue: demoWallet }],
      };
    }
    const data = await ex.fetchBalance({ type: 'swap' })
    const usdt = data.USDT ?? data["USDT"] ?? {};
    const free = (usdt.free as number) ?? 0;
    const total = (usdt.total as number) ?? 0;
    return {
      totalUsd: (data.total?.USDT as number) ?? total,
      balances: [{ asset: "USDT", free, locked: Math.max(0, total - free), usdValue: total }],
    };
  },

  async getPositions() {
    if (IS_DEMO) {
      for (const pos of demoPositions) {
        try {
          const ticker = await fetchPublicTicker(pos.symbol);
          pos.currentPrice = ticker.price;
          const diff = (ticker.price - pos.entryPrice) / pos.entryPrice;
          pos.pnl = diff * pos.quantity * pos.entryPrice * (pos.side === "long" ? 1 : -1);
          pos.pnlPercent = diff * 100 * (pos.side === "long" ? 1 : -1);
        } catch { /* ignore */ }
      }
      return [...demoPositions];
    }

    const data = await ex.fetchPositions();
    return data
      .filter((p) => Math.abs(p.contracts ?? 0) > 0 || Math.abs(parseFloat(String(p.contractSize ?? "0"))) > 0)
      .map((p) => {
        const qty = Math.abs(p.contracts ?? parseFloat(String(p.contractSize ?? "0")));
        const side = (p.side === "short") ? "short" : "long";
        const entry = p.entryPrice ?? 0;
        const mark = p.markPrice ?? p.lastPrice ?? entry;
        const pnl = p.unrealizedPnl ?? 0;
        const pnlPercent = entry > 0 ? ((mark - entry) / entry) * 100 * (side === "long" ? 1 : -1) : 0;
        // 원래 심볼 형태로 복원 (BTC/USDT:USDT → BTC/USDT)
        const sym = (p.symbol ?? "").replace(":USDT", "");
        return { symbol: sym, side, entryPrice: entry, currentPrice: mark, quantity: qty, pnl, pnlPercent, openedAt: Date.now() };
      });
  },

  async placeOrder(
    symbol: string,
    side: string,
    type: string,
    quantity: number,
    price?: number,
    opts: PlaceOrderOpts = {},
  ) {
    const sideUpper = side.toUpperCase();
    const positionSide: PositionSide = opts.positionSide ?? (sideUpper === "BUY" ? "LONG" : "SHORT");

    if (IS_DEMO) {
      const ticker = await fetchPublicTicker(symbol);
      const fillPrice = type === "market" ? ticker.price : (price ?? ticker.price);
      const order = {
        id: `DEMO-${demoOrderCounter++}`, symbol, side, type,
        status: type === "market" ? "filled" : "open",
        price: fillPrice, quantity, filled: type === "market" ? quantity : 0,
        timestamp: Date.now(),
      };
      if (type === "market") {
        const isOpen = (sideUpper === "BUY" && positionSide === "LONG") || (sideUpper === "SELL" && positionSide === "SHORT");
        if (isOpen) {
          demoPositions.push({
            symbol, side: positionSide === "LONG" ? "long" : "short",
            entryPrice: fillPrice, currentPrice: fillPrice, quantity, pnl: 0, pnlPercent: 0, openedAt: Date.now(),
          });
        } else {
          const idx = demoPositions.findIndex((p) => p.symbol === symbol && p.side === (positionSide === "LONG" ? "long" : "short"));
          if (idx >= 0) {
            const pos = demoPositions[idx];
            const realized = (fillPrice - pos.entryPrice) * pos.quantity * (pos.side === "long" ? 1 : -1);
            demoWallet += realized;
            demoPositions.splice(idx, 1);
          }
        }
      } else {
        demoOrders.push(order);
      }
      return order;
    }

    const swapSym = toSwapSymbol(symbol);
    const isClosing = opts.reduceOnly ||
      (sideUpper === "SELL" && positionSide === "LONG") ||
      (sideUpper === "BUY" && positionSide === "SHORT");

    if (!isClosing && opts.leverage) {
      await ensureSymbolSetup(symbol, opts.leverage, opts.marginType ?? "isolated");
    }

    const params: Record<string, unknown> = {
      positionSide: positionSide, // 비트겟 헤지 모드
    };
    if (opts.reduceOnly) params.reduceOnly = true;
    if (type === "limit" && price) params.price = price;

    const order = await ex.createOrder(
      swapSym,
      type,
      sideUpper.toLowerCase(),
      quantity,
      type === "limit" ? price : undefined,
      params,
    );

    return {
      id: String(order.id),
      symbol,
      side: order.side?.toLowerCase() ?? side.toLowerCase(),
      type: order.type?.toLowerCase() ?? type.toLowerCase(),
      status: order.status?.toLowerCase() ?? "open",
      price: order.average ?? order.price ?? price ?? 0,
      quantity: order.amount ?? quantity,
      filled: order.filled ?? 0,
      timestamp: order.timestamp ?? Date.now(),
    };
  },

  async getOpenOrders(symbol?: string) {
    if (IS_DEMO) {
      return demoOrders.filter((o) => o.status === "open" && (!symbol || o.symbol === symbol));
    }
    const swapSym = symbol ? toSwapSymbol(symbol) : undefined;
    const orders = await ex.fetchOpenOrders(swapSym);
    return orders.map((o) => ({
      id: String(o.id),
      symbol: (o.symbol ?? "").replace(":USDT", ""),
      side: o.side?.toLowerCase() ?? "",
      type: o.type?.toLowerCase() ?? "",
      status: o.status?.toLowerCase() ?? "",
      price: o.price ?? 0,
      quantity: o.amount ?? 0,
      filled: o.filled ?? 0,
      timestamp: o.timestamp ?? Date.now(),
    }));
  },

  async cancelOrder(orderId: string, symbol: string) {
    if (IS_DEMO) {
      const idx = demoOrders.findIndex((o) => o.id === orderId);
      if (idx >= 0) demoOrders.splice(idx, 1);
      return true;
    }
    await ex.cancelOrder(orderId, toSwapSymbol(symbol));
    return true;
  },

  async ensureFuturesSetup(symbol: string, leverage: number, marginType: string) {
    return ensureSymbolSetup(symbol, leverage, marginType);
  },

  async getPositionAmount(symbol: string, positionSide: PositionSide): Promise<number> {
    if (IS_DEMO) {
      const target = positionSide === "LONG" ? "long" : "short";
      const found = demoPositions.find((p) => p.symbol === symbol && p.side === target);
      return found ? found.quantity : 0;
    }
    const swapSym = toSwapSymbol(symbol);
    const positions = await ex.fetchPositions([swapSym]);
    const target = positionSide === "LONG" ? "long" : "short";
    const found = positions.find((p) => p.side === target);
    return Math.abs(found?.contracts ?? 0);
  },
};
