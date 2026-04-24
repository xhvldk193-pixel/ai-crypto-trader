// Divergence analysis — TypeScript port of the Pine Script indicator logic

export type Candle = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };

type DivergenceSignal = {
  indicator: string;
  type: "positive_regular" | "negative_regular" | "positive_hidden" | "negative_hidden";
  strength: number;
  barIndex: number;
  description: string;
};

function computeRsi(closes: number[], period = 14): number[] {
  const rsi: number[] = new Array(closes.length).fill(50);
  if (closes.length <= period) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    rsi[i] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
  }
  return rsi;
}

function sma(data: number[], period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += data[i - j];
    result[i] = sum / period;
  }
  return result;
}

function ema(data: number[], period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  const k = 2 / (period + 1);
  let prev = NaN;
  for (let i = 0; i < data.length; i++) {
    if (isNaN(data[i])) { result[i] = NaN; continue; }
    if (isNaN(prev)) { prev = data[i]; result[i] = prev; continue; }
    prev = data[i] * k + prev * (1 - k);
    result[i] = prev;
  }
  return result;
}

function computeMacd(closes: number[]): number[] {
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  return closes.map((_, i) => (isNaN(fast[i]) || isNaN(slow[i])) ? NaN : fast[i] - slow[i]);
}

function computeObv(closes: number[], volumes: number[]): number[] {
  const obv: number[] = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    obv[i] = obv[i - 1] + (closes[i] > closes[i - 1] ? volumes[i] : closes[i] < closes[i - 1] ? -volumes[i] : 0);
  }
  return obv;
}

function computeMom(closes: number[], period = 10): number[] {
  return closes.map((c, i) => i >= period ? c - closes[i - period] : NaN);
}

function computeCci(closes: number[], highs: number[], lows: number[], period = 10): number[] {
  const cci: number[] = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1).map((c, j) => (c + highs[i - period + 1 + j] + lows[i - period + 1 + j]) / 3);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const md = slice.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
    cci[i] = md === 0 ? 0 : (slice[slice.length - 1] - mean) / (0.015 * md);
  }
  return cci;
}

function findPivotHighs(data: number[], period = 5): Array<{ index: number; value: number }> {
  const pivots: Array<{ index: number; value: number }> = [];
  for (let i = period; i < data.length - period; i++) {
    let isPivot = true;
    for (let j = -period; j <= period; j++) {
      if (j !== 0 && data[i + j] >= data[i]) { isPivot = false; break; }
    }
    if (isPivot) pivots.push({ index: i, value: data[i] });
  }
  return pivots;
}

function findPivotLows(data: number[], period = 5): Array<{ index: number; value: number }> {
  const pivots: Array<{ index: number; value: number }> = [];
  for (let i = period; i < data.length - period; i++) {
    let isPivot = true;
    for (let j = -period; j <= period; j++) {
      if (j !== 0 && data[i + j] <= data[i]) { isPivot = false; break; }
    }
    if (isPivot) pivots.push({ index: i, value: data[i] });
  }
  return pivots;
}

function detectDivergences(
  priceLows: Array<{ index: number; value: number }>,
  priceHighs: Array<{ index: number; value: number }>,
  indicatorData: number[],
  indicatorName: string,
  maxLookback = 5
): DivergenceSignal[] {
  const signals: DivergenceSignal[] = [];
  const n = indicatorData.length;
  const lastIdx = n - 1;

  // Positive Regular: price lower low, indicator higher low → bullish reversal
  const lastLow = priceLows[priceLows.length - 1];
  if (lastLow && lastLow.index > n - 30) {
    const priorLows = priceLows.slice(0, -1).slice(-maxLookback);
    for (const pl of priorLows) {
      if (lastLow.value < pl.value && indicatorData[lastLow.index] > indicatorData[pl.index]) {
        const strength = Math.abs(indicatorData[lastLow.index] - indicatorData[pl.index]) /
          (Math.abs(indicatorData[pl.index]) || 1);
        signals.push({
          indicator: indicatorName,
          type: "positive_regular",
          strength: Math.min(1, strength),
          barIndex: lastLow.index,
          description: `${indicatorName}: Bullish Regular Divergence — price lower low, indicator higher low`
        });
        break;
      }
    }
  }

  // Negative Regular: price higher high, indicator lower high → bearish reversal
  const lastHigh = priceHighs[priceHighs.length - 1];
  if (lastHigh && lastHigh.index > n - 30) {
    const priorHighs = priceHighs.slice(0, -1).slice(-maxLookback);
    for (const ph of priorHighs) {
      if (lastHigh.value > ph.value && indicatorData[lastHigh.index] < indicatorData[ph.index]) {
        const strength = Math.abs(indicatorData[lastHigh.index] - indicatorData[ph.index]) /
          (Math.abs(indicatorData[ph.index]) || 1);
        signals.push({
          indicator: indicatorName,
          type: "negative_regular",
          strength: Math.min(1, strength),
          barIndex: lastHigh.index,
          description: `${indicatorName}: Bearish Regular Divergence — price higher high, indicator lower high`
        });
        break;
      }
    }
  }

  // Positive Hidden: price higher low, indicator lower low → bullish continuation
  if (lastLow && lastLow.index > n - 30) {
    const priorLows = priceLows.slice(0, -1).slice(-maxLookback);
    for (const pl of priorLows) {
      if (lastLow.value > pl.value && indicatorData[lastLow.index] < indicatorData[pl.index]) {
        const strength = Math.abs(indicatorData[lastLow.index] - indicatorData[pl.index]) /
          (Math.abs(indicatorData[pl.index]) || 1);
        signals.push({
          indicator: indicatorName,
          type: "positive_hidden",
          strength: Math.min(1, strength),
          barIndex: lastLow.index,
          description: `${indicatorName}: Bullish Hidden Divergence — price higher low, indicator lower low`
        });
        break;
      }
    }
  }

  // Negative Hidden: price lower high, indicator higher high → bearish continuation
  if (lastHigh && lastHigh.index > n - 30) {
    const priorHighs = priceHighs.slice(0, -1).slice(-maxLookback);
    for (const ph of priorHighs) {
      if (lastHigh.value < ph.value && indicatorData[lastHigh.index] > indicatorData[ph.index]) {
        const strength = Math.abs(indicatorData[lastHigh.index] - indicatorData[ph.index]) /
          (Math.abs(indicatorData[ph.index]) || 1);
        signals.push({
          indicator: indicatorName,
          type: "negative_hidden",
          strength: Math.min(1, strength),
          barIndex: lastHigh.index,
          description: `${indicatorName}: Bearish Hidden Divergence — price lower high, indicator higher high`
        });
        break;
      }
    }
  }

  return signals;
}

export function analyzeDivergences(candles: Candle[], symbol: string, timeframe: string) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const priceLows = findPivotLows(closes);
  const priceHighs = findPivotHighs(closes);

  const indicators: Array<{ name: string; data: number[] }> = [
    { name: "RSI", data: computeRsi(closes) },
    { name: "MACD", data: computeMacd(closes) },
    { name: "OBV", data: computeObv(closes, volumes) },
    { name: "MOM", data: computeMom(closes) },
    { name: "CCI", data: computeCci(closes, highs, lows) },
  ];

  const allSignals: DivergenceSignal[] = [];
  for (const ind of indicators) {
    // ✅ Fix #5: indLows/indHighs는 detectDivergences에서 사용되지 않는 데드 코드였음 — 제거
    // detectDivergences는 indicatorData 배열과 priceLows/priceHighs의 인덱스로 직접 비교함
    const divs = detectDivergences(priceLows, priceHighs, ind.data, ind.name);
    allSignals.push(...divs);
  }

  const bullishCount = allSignals.filter(s => s.type === "positive_regular" || s.type === "positive_hidden").length;
  const bearishCount = allSignals.filter(s => s.type === "negative_regular" || s.type === "negative_hidden").length;
  const overallBias: "bullish" | "bearish" | "neutral" =
    bullishCount > bearishCount ? "bullish" :
    bearishCount > bullishCount ? "bearish" : "neutral";

  return {
    symbol,
    timeframe,
    signals: allSignals,
    bullishCount,
    bearishCount,
    overallBias,
    analyzedAt: Date.now(),
  };
}
