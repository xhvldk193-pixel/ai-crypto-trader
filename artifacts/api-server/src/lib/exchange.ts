import { createHmac } from "node:crypto";
import { logger } from "./logger";

const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET_KEY = process.env.BINANCE_SECRET_KEY;
const IS_DEMO = !BINANCE_API_KEY || !BINANCE_SECRET_KEY || process.env.BINANCE_LIVE_MODE !== "true";
const BINANCE_FAPI = "https://fapi.binance.com";

export type PositionSide = "LONG" | "SHORT";

interface SymbolFilter {
  stepSize: number;
  minQty: number;
  tickSize: number;
  minNotional: number;
  qtyPrecision: number;
}

const symbolFiltersCache = new Map<string, SymbolFilter>();
const configuredSymbols = new Map<string, { leverage: number; marginType: string }>();
let positionModeEnsured: Promise<void> | null = null;

// ─── Demo state (futures-style: long & short can coexist) ────────────────────
let demoWallet = 10000;
const demoPositions: Array<{
  symbol: string; side: "long" | "short"; entryPrice: number; currentPrice: number;
  quantity: number; pnl: number; pnlPercent: number; openedAt: number;
}> = [];
const demoOrders: Array<{
  id: string; symbol: string; side: string; type: string;
  status: string; price: number; quantity: number; filled: number; timestamp: number;
}> = [];
let demoOrderCounter = 1;

// ─── Binance helpers ─────────────────────────────────────────────────────────

function sign(qs: string): string {
  return createHmac("sha256", BINANCE_SECRET_KEY!).update(qs).digest("hex");
}

async function binancePublic(path: string, params?: Record<string, string>) {
  const url = new URL(`${BINANCE_FAPI}${path}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Binance public ${path} ${res.status}: ${text}`);
  }
  return res.json() as Promise<unknown>;
}

interface BinanceErrorBody { code?: number; msg?: string }

async function binanceSigned(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const timestamp = Date.now().toString();
  const qs = new URLSearchParams({ ...params, timestamp, recvWindow: "5000" });
  qs.set("signature", sign(qs.toString()));
  const url = `${BINANCE_FAPI}${path}?${qs.toString()}`;
  const res = await fetch(url, { method, headers: { "X-MBX-APIKEY": BINANCE_API_KEY! } });
  if (!res.ok) {
    const text = await res.text();
    let parsed: BinanceErrorBody | null = null;
    try { parsed = JSON.parse(text) as BinanceErrorBody; } catch { /* not json */ }
    const err = new Error(`Binance ${method} ${path} ${res.status}: ${text}`) as Error & { binanceCode?: number; binanceMsg?: string };
    if (parsed?.code !== undefined) err.binanceCode = parsed.code;
    if (parsed?.msg) err.binanceMsg = parsed.msg;
    throw err;
  }
  return res.json();
}

function toBinanceSymbol(symbol: string) {
  return symbol.replace("/", "");
}

// ─── Symbol filters (precision) ──────────────────────────────────────────────

async function loadExchangeInfo(): Promise<void> {
  if (symbolFiltersCache.size > 0) return;
  const info = await binancePublic("/fapi/v1/exchangeInfo") as {
    symbols: Array<{
      symbol: string; status: string; quantityPrecision: number;
      filters: Array<{ filterType: string; stepSize?: string; minQty?: string; tickSize?: string; notional?: string }>;
    }>;
  };
  for (const s of info.symbols) {
    if (s.status !== "TRADING") continue;
    const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
    const tick = s.filters.find((f) => f.filterType === "PRICE_FILTER");
    const notional = s.filters.find((f) => f.filterType === "MIN_NOTIONAL");
    symbolFiltersCache.set(s.symbol, {
      stepSize: parseFloat(lot?.stepSize ?? "0.001") || 0.001,
      minQty: parseFloat(lot?.minQty ?? "0.001") || 0.001,
      tickSize: parseFloat(tick?.tickSize ?? "0.01") || 0.01,
      minNotional: parseFloat(notional?.notional ?? "5") || 5,
      qtyPrecision: s.quantityPrecision,
    });
  }
}

async function getSymbolFilter(binSym: string): Promise<SymbolFilter> {
  if (!symbolFiltersCache.has(binSym)) await loadExchangeInfo();
  return symbolFiltersCache.get(binSym) ?? { stepSize: 0.001, minQty: 0.001, tickSize: 0.01, minNotional: 5, qtyPrecision: 3 };
}

function roundToStep(value: number, step: number, precision: number): number {
  if (step <= 0) return Number(value.toFixed(precision));
  const rounded = Math.floor(value / step) * step;
  return Number(rounded.toFixed(precision));
}

// ─── Futures account setup (idempotent) ──────────────────────────────────────

async function ensurePositionMode(): Promise<void> {
  if (IS_DEMO) return;
  if (positionModeEnsured) return positionModeEnsured;
  positionModeEnsured = (async () => {
    try {
      await binanceSigned("POST", "/fapi/v1/positionSide/dual", { dualSidePosition: "true" });
      logger.info("Binance Futures: hedge position mode enabled");
    } catch (err) {
      const e = err as Error & { binanceCode?: number };
      if (e.binanceCode === -4059) return; // already in this mode
      logger.error({ err: String(err) }, "Failed to set hedge position mode");
      positionModeEnsured = null; // allow retry
      throw err;
    }
  })();
  return positionModeEnsured;
}

async function ensureSymbolSetup(symbol: string, leverage: number, marginType: string): Promise<void> {
  if (IS_DEMO) return;
  await ensurePositionMode();
  const cached = configuredSymbols.get(symbol);
  if (cached && cached.leverage === leverage && cached.marginType === marginType) return;

  // Margin type
  try {
    await binanceSigned("POST", "/fapi/v1/marginType", { symbol, marginType });
  } catch (err) {
    const e = err as Error & { binanceCode?: number };
    if (e.binanceCode !== -4046) { // -4046: no need to change margin type
      logger.warn({ err: String(err), symbol }, "marginType change failed");
    }
  }
  // Leverage
  try {
    await binanceSigned("POST", "/fapi/v1/leverage", { symbol, leverage: String(leverage) });
  } catch (err) {
    logger.warn({ err: String(err), symbol, leverage }, "leverage change failed");
    throw err;
  }
  configuredSymbols.set(symbol, { leverage, marginType });
}

// ─── Public market data ──────────────────────────────────────────────────────

async function fetchPublicTicker(symbol: string) {
  const s = toBinanceSymbol(symbol);
  const data = await binancePublic(`/fapi/v1/ticker/24hr`, { symbol: s }) as Record<string, string>;
  return {
    symbol,
    price: parseFloat(data.lastPrice),
    change24h: parseFloat(data.priceChange),
    changePercent24h: parseFloat(data.priceChangePercent),
    volume24h: parseFloat(data.quoteVolume),
    high24h: parseFloat(data.highPrice),
    low24h: parseFloat(data.lowPrice),
    timestamp: Date.now(),
  };
}

type Candle = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };

const BINANCE_TF_MAP: Record<string, string> = {
  "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1h": "1h", "4h": "4h", "1d": "1d",
};

async function fetchBinanceRange(
  symbol: string, timeframe: string, startMs: number, endMs: number, maxCandles: number,
): Promise<Candle[]> {
  const interval = BINANCE_TF_MAP[timeframe] || "1h";
  const s = toBinanceSymbol(symbol);
  const PAGE = 1000;
  const all: Candle[] = [];
  let cursor = startMs;
  while (cursor < endMs && all.length < maxCandles) {
    const data = await binancePublic(`/fapi/v1/klines`, {
      symbol: s, interval, startTime: cursor.toString(), endTime: endMs.toString(), limit: PAGE.toString(),
    }) as Array<[number, string, string, string, string, string]>;
    if (data.length === 0) break;
    for (const k of data) {
      all.push({
        timestamp: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      });
      if (all.length >= maxCandles) break;
    }
    const lastOpen = data[data.length - 1][0];
    if (data.length < PAGE) break;
    cursor = lastOpen + 1;
  }
  return all;
}

async function fetchFundingRate(symbol: string): Promise<number | null> {
  try {
    const s = toBinanceSymbol(symbol);
    const data = await binancePublic(`/fapi/v1/premiumIndex`, { symbol: s }) as { lastFundingRate?: string };
    const v = parseFloat(data.lastFundingRate ?? "");
    return Number.isFinite(v) ? v : null;
  } catch (err) {
    logger.warn({ err: String(err), symbol }, "Failed to fetch funding rate");
    return null;
  }
}

async function fetchOpenInterest(symbol: string): Promise<number | null> {
  try {
    const s = toBinanceSymbol(symbol);
    const data = await binancePublic(`/fapi/v1/openInterest`, { symbol: s }) as { openInterest?: string };
    const v = parseFloat(data.openInterest ?? "");
    return Number.isFinite(v) ? v : null;
  } catch (err) {
    logger.warn({ err: String(err), symbol }, "Failed to fetch open interest");
    return null;
  }
}

// ─── Exchange service ────────────────────────────────────────────────────────

export interface PlaceOrderOpts {
  positionSide?: PositionSide;
  reduceOnly?: boolean;
  leverage?: number;
  marginType?: string;
}

export const exchangeService = {
  isDemo: IS_DEMO,

  async getSymbols(): Promise<string[]> {
    try {
      const data = await binancePublic("/fapi/v1/exchangeInfo") as {
        symbols: Array<{ symbol: string; baseAsset: string; quoteAsset: string; status: string; contractType?: string }>;
      };
      return data.symbols
        .filter((s) => s.quoteAsset === "USDT" && s.status === "TRADING" && (!s.contractType || s.contractType === "PERPETUAL"))
        .slice(0, 50)
        .map((s) => `${s.baseAsset}/${s.quoteAsset}`);
    } catch {
      return ["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT", "ADA/USDT"];
    }
  },

  async getTicker(symbol: string) {
    return fetchPublicTicker(symbol);
  },

  async getOhlcv(symbol: string, timeframe: string, limit: number) {
    const interval = BINANCE_TF_MAP[timeframe] || "1h";
    const s = toBinanceSymbol(symbol);
    const data = await binancePublic(`/fapi/v1/klines`, {
      symbol: s, interval, limit: limit.toString(),
    }) as Array<[number, string, string, string, string, string]>;
    return data.map((k) => ({
      timestamp: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
  },

  async getOhlcvRange(symbol: string, timeframe: string, startMs: number, endMs: number, maxCandles = 5000) {
    return fetchBinanceRange(symbol, timeframe, startMs, endMs, maxCandles);
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
    const data = await binanceSigned("GET", "/fapi/v2/account") as {
      totalWalletBalance: string; totalMarginBalance: string; availableBalance: string; totalUnrealizedProfit: string;
      assets: Array<{ asset: string; walletBalance: string; availableBalance: string }>;
    };
    const totalUsd = parseFloat(data.totalMarginBalance) || 0;
    const usdt = data.assets.find((a) => a.asset === "USDT");
    const free = usdt ? parseFloat(usdt.availableBalance) : 0;
    const wallet = usdt ? parseFloat(usdt.walletBalance) : 0;
    return {
      totalUsd,
      balances: [{ asset: "USDT", free, locked: Math.max(0, wallet - free), usdValue: wallet }],
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
    const data = await binanceSigned("GET", "/fapi/v2/positionRisk") as Array<{
      symbol: string; positionAmt: string; entryPrice: string; markPrice: string;
      unRealizedProfit: string; positionSide: string; leverage: string;
    }>;
    return data
      .filter((p) => parseFloat(p.positionAmt) !== 0)
      .map((p) => {
        const qty = Math.abs(parseFloat(p.positionAmt));
        const side = p.positionSide === "SHORT" || (p.positionSide === "BOTH" && parseFloat(p.positionAmt) < 0) ? "short" : "long";
        const entry = parseFloat(p.entryPrice);
        const mark = parseFloat(p.markPrice);
        const pnl = parseFloat(p.unRealizedProfit);
        const pnlPercent = entry > 0 ? ((mark - entry) / entry) * 100 * (side === "long" ? 1 : -1) : 0;
        return {
          symbol: p.symbol, side, entryPrice: entry, currentPrice: mark,
          quantity: qty, pnl, pnlPercent, openedAt: Date.now(),
        };
      });
  },

  /**
   * Place a futures order. In hedge mode, positionSide MUST be set.
   * - Open long:  side=BUY,  positionSide=LONG
   * - Close long: side=SELL, positionSide=LONG
   * - Open short: side=SELL, positionSide=SHORT
   * - Close short:side=BUY,  positionSide=SHORT
   */
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
      } else if (type === "limit") {
        demoOrders.push(order);
      }
      return order;
    }

    const s = toBinanceSymbol(symbol);
    // Setup leverage/margin only when opening a new position (not for closing/reduce-only)
    const isClosing = opts.reduceOnly || (sideUpper === "SELL" && positionSide === "LONG") || (sideUpper === "BUY" && positionSide === "SHORT");
    if (!isClosing && opts.leverage) {
      await ensureSymbolSetup(s, opts.leverage, opts.marginType ?? "ISOLATED");
    } else {
      await ensurePositionMode();
    }

    const filter = await getSymbolFilter(s);
    const qtyRounded = roundToStep(quantity, filter.stepSize, filter.qtyPrecision);
    if (qtyRounded < filter.minQty) {
      throw new Error(`주문 수량이 최소 단위 미만입니다 (${qtyRounded} < ${filter.minQty} ${s}). 거래 금액을 늘려주세요.`);
    }

    const params: Record<string, string> = {
      symbol: s,
      side: sideUpper,
      type: type.toUpperCase(),
      quantity: qtyRounded.toString(),
      positionSide,
    };
    if (type === "limit" && price) {
      params.price = price.toString();
      params.timeInForce = "GTC";
    }

    const data = await binanceSigned("POST", "/fapi/v1/order", params) as {
      orderId: number; symbol: string; side: string; type: string;
      status: string; price: string; origQty: string; executedQty: string; updateTime: number;
      avgPrice?: string;
    };

    const avgPrice = data.avgPrice ? parseFloat(data.avgPrice) : 0;
    return {
      id: data.orderId.toString(),
      symbol,
      side: data.side.toLowerCase(),
      type: data.type.toLowerCase(),
      status: data.status.toLowerCase(),
      price: avgPrice > 0 ? avgPrice : (parseFloat(data.price) || (price ?? 0)),
      quantity: parseFloat(data.origQty),
      filled: parseFloat(data.executedQty),
      timestamp: data.updateTime,
    };
  },

  async getOpenOrders(symbol?: string) {
    if (IS_DEMO) return demoOrders.filter((o) => o.status === "open" && (!symbol || o.symbol === symbol));
    const params: Record<string, string> = {};
    if (symbol) params.symbol = toBinanceSymbol(symbol);
    const data = await binanceSigned("GET", "/fapi/v1/openOrders", params) as Array<{
      orderId: number; symbol: string; side: string; type: string;
      status: string; price: string; origQty: string; executedQty: string; time: number;
    }>;
    return data.map((o) => ({
      id: o.orderId.toString(), symbol: o.symbol, side: o.side.toLowerCase(),
      type: o.type.toLowerCase(), status: o.status.toLowerCase(),
      price: parseFloat(o.price), quantity: parseFloat(o.origQty),
      filled: parseFloat(o.executedQty), timestamp: o.time,
    }));
  },

  async cancelOrder(orderId: string, symbol: string) {
    if (IS_DEMO) {
      const idx = demoOrders.findIndex((o) => o.id === orderId);
      if (idx >= 0) demoOrders.splice(idx, 1);
      return true;
    }
    await binanceSigned("DELETE", "/fapi/v1/order", { symbol: toBinanceSymbol(symbol), orderId });
    return true;
  },

  // Exposed for external setup (e.g. on bot start)
  async ensureFuturesSetup(symbol: string, leverage: number, marginType: string) {
    return ensureSymbolSetup(toBinanceSymbol(symbol), leverage, marginType);
  },

  /**
   * Fetch the actual on-exchange position size for a (symbol, positionSide) pair.
   * Returns 0 if no position exists. Used before closing to avoid -2022 ReduceOnly rejections.
   */
  async getPositionAmount(symbol: string, positionSide: PositionSide): Promise<number> {
    if (IS_DEMO) {
      const target = positionSide === "LONG" ? "long" : "short";
      const found = demoPositions.find((p) => p.symbol === symbol && p.side === target);
      return found ? found.quantity : 0;
    }
    const s = toBinanceSymbol(symbol);
    const data = await binanceSigned("GET", "/fapi/v2/positionRisk", { symbol: s }) as Array<{
      symbol: string; positionAmt: string; positionSide: string;
    }>;
    const row = data.find((p) => p.positionSide === positionSide);
    if (!row) return 0;
    return Math.abs(parseFloat(row.positionAmt) || 0);
  },
};
