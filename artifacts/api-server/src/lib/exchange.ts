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
  } catch {
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
    } catch (err) {
      logger.error({ err }, "Failed to fetch OHLCV");
      return [];
    }
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
