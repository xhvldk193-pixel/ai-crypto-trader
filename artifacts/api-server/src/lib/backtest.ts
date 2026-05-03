import { analyzeDivergences } from "./divergence";
import { computeAtrPercent } from "./indicators";

export type BacktestCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export interface BacktestParams {
  symbol: string;
  timeframe: string;
  initialCapital: number;
  tradeAmount: number;
  minConfidence: number;
  takeProfitPercent?: number | null;
  stopLossPercent?: number | null;
  useAtrTargets: boolean;
  feePercent: number;
}

export interface BacktestTrade {
  id: string;
  symbol: string;
  side: "long" | "short";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  takeProfit: number;
  stopLoss: number;
  quantity: number;
  pnl: number;
  pnlPercent: number;
  exitReason: "tp" | "sl" | "eod";
  confidence: number;
  expectedMovePercent: number;
  reasoning: string;
}

export interface BacktestEquityPoint {
  timestamp: number;
  equity: number;
}

export interface BacktestResult {
  symbol: string;
  timeframe: string;
  startTime: number;
  endTime: number;
  candleCount: number;
  initialCapital: number;
  finalCapital: number;
  totalPnl: number;
  totalPnlPercent: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgPnl: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  bestTrade: number;
  worstTrade: number;
  totalFees: number;
  trades: BacktestTrade[];
  equityCurve: BacktestEquityPoint[];
}

const WARMUP_BARS = 60;

/**
 * Deterministic rule-based "AI" decision used during backtests so we don't
 * burn tokens (and so results are reproducible). Mirrors the live bot's
 * intent: bias from divergence counts + ATR-derived expected move.
 */
function decideRuleBased(input: {
  bullishCount: number;
  bearishCount: number;
  avgBullStrength: number;
  avgBearStrength: number;
  atrPercent: number | null;
}): {
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  expectedMovePercent: number;
  reasoning: string;
} {
  const { bullishCount, bearishCount, avgBullStrength, avgBearStrength, atrPercent } = input;
  const total = bullishCount + bearishCount;
  if (total === 0) {
    return { action: "HOLD", confidence: 0, expectedMovePercent: 0, reasoning: "no divergence" };
  }
  if (bullishCount === bearishCount) {
    return { action: "HOLD", confidence: 0.3, expectedMovePercent: 0, reasoning: "conflicting bias" };
  }
  const bullish = bullishCount > bearishCount;
  const dir = bullish ? 1 : -1;
  const dominance = Math.max(bullishCount, bearishCount) / total; // 0.5..1
  const strength = bullish ? avgBullStrength : avgBearStrength; // 0..1
  // Confidence weighs both how lopsided the signals are and their average strength.
  const confidence = Math.min(0.99, 0.4 + (dominance - 0.5) * 0.8 + strength * 0.4);

  // Expected move sized by ATR (with 0.5%–4% bounds), scaled by signal strength.
  const atrBase = atrPercent ?? 1;
  const moveAbs = Math.min(4, Math.max(0.5, atrBase * (1 + strength)));
  const expectedMovePercent = dir * moveAbs;

  return {
    action: bullish ? "BUY" : "SELL",
    confidence,
    expectedMovePercent,
    reasoning: `${bullish ? "강세" : "약세"} 다이버전스 ${Math.max(bullishCount, bearishCount)}/${total} (평균 강도 ${strength.toFixed(2)}), 예상 변동 ${expectedMovePercent.toFixed(2)}%`,
  };
}

function avgStrength(items: Array<{ strength: number }>): number {
  if (items.length === 0) return 0;
  return items.reduce((a, b) => a + b.strength, 0) / items.length;
}

export function runBacktest(candles: BacktestCandle[], params: BacktestParams): BacktestResult {
  const trades: BacktestTrade[] = [];
  const equityCurve: BacktestEquityPoint[] = [];
  let capital = params.initialCapital;
  let totalFees = 0;
  let tradeIdCounter = 0;

  type OpenPos = {
    side: "long" | "short";
    entryTime: number;
    entryPrice: number;
    takeProfit: number;
    stopLoss: number;
    quantity: number;
    entryFee: number;
    confidence: number;
    expectedMovePercent: number;
    reasoning: string;
  };
  let open: OpenPos | null = null;

  const closePos = (i: number, exitPrice: number, reason: "tp" | "sl" | "eod") => {
    if (!open) return;
    const dir = open.side === "long" ? 1 : -1;
    const grossPnl = (exitPrice - open.entryPrice) * open.quantity * dir;
    const exitFee = exitPrice * open.quantity * params.feePercent;
    totalFees += exitFee;
    // Include entry fee in per-trade pnl so sum(trade.pnl) === finalCapital - initialCapital.
    const pnl = grossPnl - exitFee - open.entryFee;
    capital += grossPnl - exitFee;
    const pnlPercent = ((exitPrice - open.entryPrice) / open.entryPrice) * 100 * dir;
    trades.push({
      id: `T${++tradeIdCounter}`,
      symbol: params.symbol,
      side: open.side,
      entryTime: open.entryTime,
      exitTime: candles[i].timestamp,
      entryPrice: open.entryPrice,
      exitPrice,
      takeProfit: open.takeProfit,
      stopLoss: open.stopLoss,
      quantity: open.quantity,
      pnl,
      pnlPercent,
      exitReason: reason,
      confidence: open.confidence,
      expectedMovePercent: open.expectedMovePercent,
      reasoning: open.reasoning,
    });
    open = null;
  };

  // analyzeDivergences는 항상 마지막 봉 기준으로만 신호를 계산하므로,
  // 각 봉마다 해당 봉까지의 슬라이스를 넘겨야 한다.
  // 성능을 위해 최근 300봉 윈도우만 사용 (피벗 감지에 충분).
  const WINDOW_SIZE = 300;

  const start = Math.max(WARMUP_BARS, 30);
  for (let i = start; i < candles.length; i++) {
    const bar = candles[i];

    // 1) Manage existing position first using this bar's range.
    if (open) {
      const isLong = open.side === "long";
      const tpHit = isLong ? bar.high >= open.takeProfit : bar.low <= open.takeProfit;
      const slHit = isLong ? bar.low <= open.stopLoss : bar.high >= open.stopLoss;
      // If both hit in the same bar we conservatively assume SL fired first.
      if (slHit) closePos(i, open.stopLoss, "sl");
      else if (tpHit) closePos(i, open.takeProfit, "tp");
    }

    // 2) Look for a new entry on the close of this bar.
    if (!open) {
      const window = candles.slice(Math.max(0, i - WINDOW_SIZE + 1), i + 1);
      const div = analyzeDivergences(window, params.symbol, params.timeframe, { dontConfirm: true });

      if (div.bullishCount + div.bearishCount > 0) {
        const atrPercent = computeAtrPercent(window, 14);
        const decision = decideRuleBased({
          bullishCount: div.bullishCount,
          bearishCount: div.bearishCount,
          avgBullStrength: avgStrength(div.signals.filter((s) => s.type.startsWith("positive"))),
          avgBearStrength: avgStrength(div.signals.filter((s) => s.type.startsWith("negative"))),
          atrPercent,
        });
        if (
          decision.action !== "HOLD" &&
          decision.confidence >= params.minConfidence
        ) {
          const dir = decision.action === "BUY" ? 1 : -1;
          const entryPrice = bar.close;
          let tpPct: number;
          let slPct: number;
          if (params.useAtrTargets) {
            tpPct = Math.abs(decision.expectedMovePercent);
            slPct = Math.max(0.3, tpPct * 0.5);
          } else {
            tpPct = params.takeProfitPercent ?? 2;
            slPct = params.stopLossPercent ?? 1;
          }
          const takeProfit = entryPrice * (1 + dir * tpPct / 100);
          const stopLoss = entryPrice * (1 - dir * slPct / 100);
          const quantity = params.tradeAmount / entryPrice;
          const entryFee = entryPrice * quantity * params.feePercent;
          totalFees += entryFee;
          capital -= entryFee;
          open = {
            side: decision.action === "BUY" ? "long" : "short",
            entryTime: bar.timestamp,
            entryPrice,
            takeProfit,
            stopLoss,
            quantity,
            entryFee,
            confidence: decision.confidence,
            expectedMovePercent: decision.expectedMovePercent,
            reasoning: decision.reasoning,
          };
        }
      }
    }

    // 3) Mark-to-market equity (close-based).
    let equity = capital;
    if (open) {
      const dir = open.side === "long" ? 1 : -1;
      const unrealized = (bar.close - open.entryPrice) * open.quantity * dir;
      equity += unrealized;
    }
    equityCurve.push({ timestamp: bar.timestamp, equity });
  }

  // Force-close any dangling position at the last close, then re-anchor the
  // final equity point to the post-close capital so the chart agrees with
  // finalCapital (and drawdown reflects the final exit fee).
  if (open && candles.length > 0) {
    const last = candles[candles.length - 1];
    closePos(candles.length - 1, last.close, "eod");
    if (equityCurve.length > 0) {
      equityCurve[equityCurve.length - 1] = { timestamp: last.timestamp, equity: capital };
    }
  }

  // Aggregate metrics
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = losses.reduce((a, t) => a + Math.abs(t.pnl), 0);
  const profitFactor = grossLoss === 0 ? (grossWin > 0 ? 999 : 0) : grossWin / grossLoss;

  // Drawdown from equity curve
  let peak = params.initialCapital;
  let maxDd = 0;
  let maxDdPct = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
  }

  return {
    symbol: params.symbol,
    timeframe: params.timeframe,
    startTime: candles[0]?.timestamp ?? 0,
    endTime: candles[candles.length - 1]?.timestamp ?? 0,
    candleCount: candles.length,
    initialCapital: params.initialCapital,
    finalCapital: capital,
    totalPnl,
    totalPnlPercent: (totalPnl / params.initialCapital) * 100,
    totalTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: trades.length === 0 ? 0 : (wins.length / trades.length) * 100,
    avgPnl: trades.length === 0 ? 0 : totalPnl / trades.length,
    avgWin: wins.length === 0 ? 0 : grossWin / wins.length,
    avgLoss: losses.length === 0 ? 0 : -grossLoss / losses.length,
    profitFactor,
    maxDrawdown: maxDd,
    maxDrawdownPercent: maxDdPct,
    bestTrade: trades.length === 0 ? 0 : trades.reduce((a, t) => (t.pnl > a ? t.pnl : a), trades[0].pnl),
    worstTrade: trades.length === 0 ? 0 : trades.reduce((a, t) => (t.pnl < a ? t.pnl : a), trades[0].pnl),
    totalFees,
    trades,
    equityCurve,
  };
}

