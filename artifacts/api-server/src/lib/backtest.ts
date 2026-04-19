import { analyzeDivergences } from "./divergence";
import type { Candle } from "./divergence";

export interface BacktestParams {
  symbol: string;
  timeframe: string;
  candles: Candle[];
  tradeAmountUsd: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  feePercent: number;
  warmupBars: number;
  windowBars: number;
}

export interface BacktestTrade {
  entryTime: number;
  exitTime: number;
  side: "BUY" | "SELL";
  entryPrice: number;
  exitPrice: number;
  takeProfit: number;
  stopLoss: number;
  quantity: number;
  pnlUsd: number;
  pnlPercent: number;
  exitReason: "tp" | "sl" | "end";
  bullishCount: number;
  bearishCount: number;
}

export interface EquityPoint {
  time: number;
  equity: number;
}

export interface BacktestMetrics {
  initialEquity: number;
  finalEquity: number;
  totalReturnPercent: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRatePercent: number;
  avgWinUsd: number;
  avgLossUsd: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
}

export interface BacktestResult {
  symbol: string;
  timeframe: string;
  startTime: number;
  endTime: number;
  params: Omit<BacktestParams, "candles">;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  metrics: BacktestMetrics;
}

function computeMetrics(trades: BacktestTrade[], equityCurve: EquityPoint[], initialEquity: number): BacktestMetrics {
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd <= 0);
  const winSum = wins.reduce((a, t) => a + t.pnlUsd, 0);
  const lossSum = losses.reduce((a, t) => a + Math.abs(t.pnlUsd), 0);

  let peak = initialEquity;
  let maxDd = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = (peak - p.equity) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev > 0) returns.push((equityCurve[i].equity - prev) / prev);
  }
  const meanRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1 ? returns.reduce((a, b) => a + (b - meanRet) ** 2, 0) / (returns.length - 1) : 0;
  const stdRet = Math.sqrt(variance);
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(returns.length) : 0;

  const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initialEquity;

  return {
    initialEquity,
    finalEquity,
    totalReturnPercent: ((finalEquity - initialEquity) / initialEquity) * 100,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePercent: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    avgWinUsd: wins.length > 0 ? winSum / wins.length : 0,
    avgLossUsd: losses.length > 0 ? -lossSum / losses.length : 0,
    profitFactor: lossSum > 0 ? winSum / lossSum : winSum > 0 ? Infinity : 0,
    maxDrawdownPercent: maxDd * 100,
    sharpeRatio: sharpe,
  };
}

export function runBacktest(p: BacktestParams): BacktestResult {
  const {
    symbol,
    timeframe,
    candles,
    tradeAmountUsd,
    stopLossPercent,
    takeProfitPercent,
    feePercent,
    warmupBars,
    windowBars,
  } = p;

  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const initialEquity = 10000;
  let equity = initialEquity;

  let position:
    | {
        side: "BUY" | "SELL";
        entryTime: number;
        entryPrice: number;
        takeProfit: number;
        stopLoss: number;
        quantity: number;
        bullishCount: number;
        bearishCount: number;
      }
    | null = null;

  for (let i = warmupBars; i < candles.length; i++) {
    const candle = candles[i];

    if (position) {
      let exitPrice: number | null = null;
      let exitReason: "tp" | "sl" | null = null;
      if (position.side === "BUY") {
        if (candle.low <= position.stopLoss) {
          exitPrice = position.stopLoss;
          exitReason = "sl";
        } else if (candle.high >= position.takeProfit) {
          exitPrice = position.takeProfit;
          exitReason = "tp";
        }
      } else {
        if (candle.high >= position.stopLoss) {
          exitPrice = position.stopLoss;
          exitReason = "sl";
        } else if (candle.low <= position.takeProfit) {
          exitPrice = position.takeProfit;
          exitReason = "tp";
        }
      }

      if (exitPrice !== null && exitReason !== null) {
        const grossPnl =
          position.side === "BUY"
            ? (exitPrice - position.entryPrice) * position.quantity
            : (position.entryPrice - exitPrice) * position.quantity;
        const fees = (position.entryPrice + exitPrice) * position.quantity * (feePercent / 100);
        const pnlUsd = grossPnl - fees;
        equity += pnlUsd;
        trades.push({
          entryTime: position.entryTime,
          exitTime: candle.timestamp,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice,
          takeProfit: position.takeProfit,
          stopLoss: position.stopLoss,
          quantity: position.quantity,
          pnlUsd,
          pnlPercent: (pnlUsd / tradeAmountUsd) * 100,
          exitReason,
          bullishCount: position.bullishCount,
          bearishCount: position.bearishCount,
        });
        position = null;
      }
    }

    if (!position) {
      const start = Math.max(0, i - windowBars + 1);
      const window = candles.slice(start, i + 1);
      const analysis = analyzeDivergences(window, symbol, timeframe);
      const bias = analysis.overallBias;
      if (bias === "bullish" || bias === "bearish") {
        const side: "BUY" | "SELL" = bias === "bullish" ? "BUY" : "SELL";
        const entryPrice = candle.close;
        const quantity = tradeAmountUsd / entryPrice;
        const tpMul = side === "BUY" ? 1 + takeProfitPercent / 100 : 1 - takeProfitPercent / 100;
        const slMul = side === "BUY" ? 1 - stopLossPercent / 100 : 1 + stopLossPercent / 100;
        position = {
          side,
          entryTime: candle.timestamp,
          entryPrice,
          takeProfit: entryPrice * tpMul,
          stopLoss: entryPrice * slMul,
          quantity,
          bullishCount: analysis.bullishCount,
          bearishCount: analysis.bearishCount,
        };
      }
    }

    const markEquity = position
      ? equity +
        (position.side === "BUY"
          ? (candle.close - position.entryPrice) * position.quantity
          : (position.entryPrice - candle.close) * position.quantity)
      : equity;
    equityCurve.push({ time: candle.timestamp, equity: markEquity });
  }

  if (position) {
    const last = candles[candles.length - 1];
    const grossPnl =
      position.side === "BUY"
        ? (last.close - position.entryPrice) * position.quantity
        : (position.entryPrice - last.close) * position.quantity;
    const fees = (position.entryPrice + last.close) * position.quantity * (feePercent / 100);
    const pnlUsd = grossPnl - fees;
    equity += pnlUsd;
    trades.push({
      entryTime: position.entryTime,
      exitTime: last.timestamp,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: last.close,
      takeProfit: position.takeProfit,
      stopLoss: position.stopLoss,
      quantity: position.quantity,
      pnlUsd,
      pnlPercent: (pnlUsd / tradeAmountUsd) * 100,
      exitReason: "end",
      bullishCount: position.bullishCount,
      bearishCount: position.bearishCount,
    });
    if (equityCurve.length > 0) equityCurve[equityCurve.length - 1].equity = equity;
  }

  return {
    symbol,
    timeframe,
    startTime: candles[warmupBars]?.timestamp ?? 0,
    endTime: candles[candles.length - 1]?.timestamp ?? 0,
    params: {
      symbol,
      timeframe,
      tradeAmountUsd,
      stopLossPercent,
      takeProfitPercent,
      feePercent,
      warmupBars,
      windowBars,
    },
    trades,
    equityCurve,
    metrics: computeMetrics(trades, equityCurve, initialEquity),
  };
}
