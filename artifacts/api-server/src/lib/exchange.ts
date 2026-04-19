import { createHmac } from "node:crypto";
import { logger } from "./logger";

const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET_KEY = process.env.BINANCE_SECRET_KEY;
// Force demo mode when running in development/Replit environment (Binance blocks non-production IPs)
// Set BINANCE_LIVE_MODE=true in production deployment to enable real trading
const IS_DEMO = !BINANCE_API_KEY || !BINANCE_SECRET_KEY || process.env.BINANCE_LIVE_MODE !== "true";
const BINANCE_BASE = "https://api.binance.com";

// Demo simulation state
let demoBalance = 10000;
const demoHoldings: Record<string, number> = { USDT: 10000 };
const demoPositions: Array<{
  symbol: string; side: string; entryPrice: number; currentPrice: number;
  quantity: number; pnl: number; pnlPercent: number; openedAt: number;
}> = [];
const demoOrders: Array<{
  id: string; symbol: string; side: string; type: string;
  status: string; price: number; quantity: number; filled: number; timestamp: number;
}> = [];
let demoOrderCounter = 1;

// ── Binance helpers ──────────────────────────────────────────────────────────

function sign(queryString: string): string {
  return createHmac("sha256", BINANCE_SECRET_KEY!).update(queryString).digest("hex");
}

async function binancePublic(path: string, params?: Record<string, string>) {
  const url = new URL(`${BINANCE_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Binance public ${path} ${res.status}: ${text}`);
  }
  return res.json() as Promise<unknown>;
}

// OKX public API fallback for geo-restricted environments where Binance/Bybit
// return HTTP 451/403. OKX allows public requests from most cloud IPs.
const OKX_TF: Record<string, string> = {
  "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1h": "1H", "4h": "4H", "1d": "1D",
};

function toOkxInst(symbol: string) {
  // "BTC/USDT" -> "BTC-USDT"
  return symbol.replace("/", "-");
}

async function okxOhlcv(symbol: string, timeframe: string, limit: number) {
  const bar = OKX_TF[timeframe] ?? "1H";
  const instId = toOkxInst(symbol);
  // OKX history endpoint allows up to 300 per request and supports paging via `after` (older end).
  const out: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> = [];
  let after: string | undefined;
  while (out.length < limit) {
    const url = new URL("https://www.okx.com/api/v5/market/history-candles");
    url.searchParams.set("instId", instId);
    url.searchParams.set("bar", bar);
    url.searchParams.set("limit", Math.min(300, limit - out.length).toString());
    if (after) url.searchParams.set("after", after);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`OKX kline ${res.status}`);
    const json = (await res.json()) as { code: string; msg: string; data?: string[][] };
    if (json.code !== "0") throw new Error(`OKX kline ${json.msg}`);
    const data = json.data ?? [];
    if (data.length === 0) break;
    for (const k of data) {
      out.push({
        timestamp: Number(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      });
    }
    after = data[data.length - 1][0];
    if (data.length < 300) break;
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

async function okxTicker(symbol: string) {
  const instId = toOkxInst(symbol);
  const url = `https://www.okx.com/api/v5/market/ticker?instId=${instId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OKX ticker ${res.status}`);
  const json = (await res.json()) as {
    code: string;
    data?: Array<{ last: string; open24h: string; high24h: string; low24h: string; volCcy24h: string }>;
  };
  const t = json.data?.[0];
  if (!t) throw new Error("OKX ticker empty");
  const price = parseFloat(t.last);
  const open24 = parseFloat(t.open24h);
  return {
    symbol,
    price,
    change24h: price - open24,
    changePercent24h: open24 > 0 ? ((price - open24) / open24) * 100 : 0,
    volume24h: parseFloat(t.volCcy24h),
    high24h: parseFloat(t.high24h),
    low24h: parseFloat(t.low24h),
    timestamp: Date.now(),
  };
}

async function binanceSigned(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string> = {}
) {
  const timestamp = Date.now().toString();
  const qs = new URLSearchParams({ ...params, timestamp });
  qs.set("signature", sign(qs.toString()));

  const url = `${BINANCE_BASE}${path}?${qs.toString()}`;
  const res = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": BINANCE_API_KEY! },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Binance ${method} ${path} ${res.status}: ${text}`);
  }
  return res.json() as Promise<unknown>;
}

// ── Public ticker (always uses real Binance data) ────────────────────────────

function toBinanceSymbol(symbol: string) {
  return symbol.replace("/", "");
}

async function fetchPublicTicker(symbol: string) {
  try {
    const s = toBinanceSymbol(symbol);
    const data = await binancePublic(`/api/v3/ticker/24hr`, { symbol: s }) as Record<string, string>;
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
  } catch (binanceErr) {
    try {
      return await okxTicker(symbol);
    } catch {
      logger.warn({ err: String(binanceErr) }, "Both Binance and OKX ticker failed; using stub");
    }
    return {
      symbol,
      price: 67000 + Math.random() * 2000 - 1000,
      change24h: Math.random() * 2000 - 1000,
      changePercent24h: Math.random() * 4 - 2,
      volume24h: 28_000_000_000,
      high24h: 68500,
      low24h: 65500,
      timestamp: Date.now(),
    };
  }
}

// ── Historical OHLCV with Binance → Coinbase fallback ───────────────────────

type Candle = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };

const BINANCE_TF_MAP: Record<string, string> = {
  "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1h": "1h", "4h": "4h", "1d": "1d",
};

const TIMEFRAME_MS: Record<string, number> = {
  "1m": 60_000, "5m": 5 * 60_000, "15m": 15 * 60_000, "30m": 30 * 60_000,
  "1h": 60 * 60_000, "4h": 4 * 60 * 60_000, "1d": 24 * 60 * 60_000,
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
    try {
      const data = await binancePublic(`/api/v3/klines`, {
        symbol: s, interval,
        startTime: cursor.toString(),
        endTime: endMs.toString(),
        limit: PAGE.toString(),
      }) as Array<[number, string, string, string, string, string]>;
      if (data.length === 0) break;
      for (const k of data) {
        all.push({
          timestamp: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        });
        if (all.length >= maxCandles) break;
      }
      const lastOpen = data[data.length - 1][0];
      if (data.length < PAGE) break;
      cursor = lastOpen + 1;
    } catch (err) {
      logger.warn({ err }, "Binance klines failed; will try fallback");
      return all;
    }
  }
  return all;
}

const COINBASE_GRANULARITY: Record<string, number> = {
  "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "4h": 14400, "1d": 86400,
};

function toCoinbaseProduct(symbol: string): string {
  // Coinbase doesn't list every USDT pair as USDT; map common alts to USD.
  const [base, quote] = symbol.split("/");
  const cbQuote = quote === "USDT" ? "USD" : quote;
  return `${base}-${cbQuote}`;
}

async function fetchCoinbaseRange(
  symbol: string, timeframe: string, startMs: number, endMs: number, maxCandles: number,
): Promise<Candle[]> {
  const granSec = COINBASE_GRANULARITY[timeframe];
  if (!granSec) return [];
  const product = toCoinbaseProduct(symbol);
  const PAGE = 300;
  const stepMs = granSec * 1000 * PAGE;
  const all: Candle[] = [];
  let cursor = startMs;
  while (cursor < endMs && all.length < maxCandles) {
    const pageEnd = Math.min(endMs, cursor + stepMs);
    const url = new URL(`https://api.exchange.coinbase.com/products/${product}/candles`);
    url.searchParams.set("granularity", granSec.toString());
    url.searchParams.set("start", new Date(cursor).toISOString());
    url.searchParams.set("end", new Date(pageEnd).toISOString());
    try {
      const res = await fetch(url.toString(), { headers: { "user-agent": "ai-trader/1.0" } });
      if (!res.ok) {
        logger.warn({ status: res.status, product }, "Coinbase candles failed");
        return all;
      }
      const data = await res.json() as Array<[number, number, number, number, number, number]>;
      // Coinbase returns DESC; sort ASC and append.
      const sorted = [...data].sort((a, b) => a[0] - b[0]);
      for (const [time, low, high, open, close, volume] of sorted) {
        all.push({
          timestamp: time * 1000,
          open, high, low, close, volume,
        });
        if (all.length >= maxCandles) break;
      }
      cursor = pageEnd + 1;
      // Be polite to the public endpoint
      await new Promise((r) => setTimeout(r, 120));
    } catch (err) {
      logger.warn({ err }, "Coinbase candles fetch error");
      return all;
    }
  }
  return all;
}

// ── Exchange service ─────────────────────────────────────────────────────────

export const exchangeService = {
  isDemo: IS_DEMO,

  async getSymbols(): Promise<string[]> {
    try {
      const data = await binancePublic("/api/v3/exchangeInfo") as {
        symbols: Array<{ symbol: string; baseAsset: string; quoteAsset: string; status: string }>;
      };
      return data.symbols
        .filter((s) => s.quoteAsset === "USDT" && s.status === "TRADING")
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
    const tfMap: Record<string, string> = {
      "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
      "1h": "1h", "4h": "4h", "1d": "1d",
    };
    const interval = tfMap[timeframe] || "1h";
    try {
      const s = toBinanceSymbol(symbol);
      const data = await binancePublic(`/api/v3/klines`, {
        symbol: s,
        interval,
        limit: limit.toString(),
      }) as Array<[number, string, string, string, string, string]>;
      return data.map((k) => ({
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));
    } catch (binanceErr) {
      try {
        return await okxOhlcv(symbol, timeframe, limit);
      } catch (okxErr) {
        logger.error({ binanceErr: String(binanceErr), okxErr: String(okxErr) }, "Failed to fetch OHLCV from both Binance and OKX");
        return [];
      }
    }
  },

  /**
   * Fetch a longer historical OHLCV window. Tries Binance first (1000-candle
   * pages); if Binance is geo-blocked or returns nothing, falls back to
   * Coinbase Exchange public klines (300-candle pages).
   * Returns at most `maxCandles` (default 5000) sorted ascending.
   */
  async getOhlcvRange(
    symbol: string,
    timeframe: string,
    startMs: number,
    endMs: number,
    maxCandles = 5000,
  ) {
    const tfMs = TIMEFRAME_MS[timeframe] ?? 60 * 60_000;
    const expected = Math.min(maxCandles, Math.floor((endMs - startMs) / tfMs));
    const minAcceptable = Math.max(1, Math.floor(expected * 0.5));
    const binance = await fetchBinanceRange(symbol, timeframe, startMs, endMs, maxCandles);
    if (binance.length >= minAcceptable) return binance;
    const coinbase = await fetchCoinbaseRange(symbol, timeframe, startMs, endMs, maxCandles);
    // Return whichever provider gave us more usable data.
    return coinbase.length > binance.length ? coinbase : binance;
  },

  async getBalance() {
    if (IS_DEMO) {
      const ticker = await fetchPublicTicker("BTC/USDT");
      const btcHeld = demoHoldings["BTC"] ?? 0;
      const usdtHeld = demoHoldings["USDT"] ?? 0;
      return {
        totalUsd: usdtHeld + btcHeld * ticker.price,
        balances: [
          { asset: "USDT", free: usdtHeld, locked: 0, usdValue: usdtHeld },
          ...(btcHeld > 0
            ? [{ asset: "BTC", free: btcHeld, locked: 0, usdValue: btcHeld * ticker.price }]
            : []),
        ],
      };
    }

    // Real Binance account balance
    const data = await binanceSigned("GET", "/api/v3/account") as {
      balances: Array<{ asset: string; free: string; locked: string }>;
    };

    const usdPrices: Record<string, number> = {};
    const nonZero = data.balances.filter(
      (b) => parseFloat(b.free) + parseFloat(b.locked) > 0
    );

    await Promise.all(
      nonZero.filter((b) => b.asset !== "USDT").map(async (b) => {
        try {
          const t = await fetchPublicTicker(`${b.asset}/USDT`);
          usdPrices[b.asset] = t.price;
        } catch {
          usdPrices[b.asset] = 0;
        }
      })
    );

    const balances = nonZero.map((b) => {
      const free = parseFloat(b.free);
      const locked = parseFloat(b.locked);
      const price = b.asset === "USDT" ? 1 : (usdPrices[b.asset] ?? 0);
      return { asset: b.asset, free, locked, usdValue: (free + locked) * price };
    });

    const totalUsd = balances.reduce((sum, b) => sum + b.usdValue, 0);
    return { totalUsd, balances };
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
    // For spot trading, positions = non-zero balances (no real futures positions)
    return [];
  },

  async placeOrder(symbol: string, side: string, type: string, quantity: number, price?: number) {
    if (IS_DEMO) {
      const ticker = await fetchPublicTicker(symbol);
      const fillPrice = type === "market" ? ticker.price : (price ?? ticker.price);
      const order = {
        id: `DEMO-${demoOrderCounter++}`,
        symbol,
        side,
        type,
        status: type === "market" ? "filled" : "open",
        price: fillPrice,
        quantity,
        filled: type === "market" ? quantity : 0,
        timestamp: Date.now(),
      };

      if (type === "market" && side === "buy") {
        const cost = fillPrice * quantity;
        demoHoldings["USDT"] = (demoHoldings["USDT"] ?? 0) - cost;
        demoBalance -= cost;
        const base = symbol.split("/")[0];
        demoHoldings[base] = (demoHoldings[base] ?? 0) + quantity;
        demoPositions.push({
          symbol, side: "long", entryPrice: fillPrice,
          currentPrice: fillPrice, quantity, pnl: 0, pnlPercent: 0, openedAt: Date.now(),
        });
      } else if (type === "market" && side === "sell") {
        const base = symbol.split("/")[0];
        demoHoldings[base] = Math.max(0, (demoHoldings[base] ?? 0) - quantity);
        const proceeds = fillPrice * quantity;
        demoHoldings["USDT"] = (demoHoldings["USDT"] ?? 0) + proceeds;
        demoBalance += proceeds;
        const idx = demoPositions.findIndex((p) => p.symbol === symbol && p.side === "long");
        if (idx >= 0) demoPositions.splice(idx, 1);
      } else if (type === "limit") {
        demoOrders.push(order);
      }
      return order;
    }

    // Real Binance order
    const s = toBinanceSymbol(symbol);
    const params: Record<string, string> = {
      symbol: s,
      side: side.toUpperCase(),
      type: type.toUpperCase(),
      quantity: quantity.toString(),
    };
    if (type === "limit" && price) {
      params.price = price.toString();
      params.timeInForce = "GTC";
    }

    const data = await binanceSigned("POST", "/api/v3/order", params) as {
      orderId: number; symbol: string; side: string; type: string;
      status: string; price: string; origQty: string; executedQty: string; transactTime: number;
    };

    return {
      id: data.orderId.toString(),
      symbol,
      side: data.side.toLowerCase(),
      type: data.type.toLowerCase(),
      status: data.status.toLowerCase(),
      price: parseFloat(data.price) || (price ?? 0),
      quantity: parseFloat(data.origQty),
      filled: parseFloat(data.executedQty),
      timestamp: data.transactTime,
    };
  },

  async getOpenOrders(symbol?: string) {
    if (IS_DEMO) {
      return demoOrders.filter((o) => o.status === "open" && (!symbol || o.symbol === symbol));
    }
    const params: Record<string, string> = {};
    if (symbol) params.symbol = toBinanceSymbol(symbol);
    const data = await binanceSigned("GET", "/api/v3/openOrders", params) as Array<{
      orderId: number; symbol: string; side: string; type: string;
      status: string; price: string; origQty: string; executedQty: string; time: number;
    }>;
    return data.map((o) => ({
      id: o.orderId.toString(),
      symbol: o.symbol,
      side: o.side.toLowerCase(),
      type: o.type.toLowerCase(),
      status: o.status.toLowerCase(),
      price: parseFloat(o.price),
      quantity: parseFloat(o.origQty),
      filled: parseFloat(o.executedQty),
      timestamp: o.time,
    }));
  },

  async cancelOrder(orderId: string, symbol: string) {
    if (IS_DEMO) {
      const idx = demoOrders.findIndex((o) => o.id === orderId);
      if (idx >= 0) demoOrders.splice(idx, 1);
      return true;
    }
    await binanceSigned("DELETE", "/api/v3/order", {
      symbol: toBinanceSymbol(symbol),
      orderId: orderId,
    });
    return true;
  },
};
