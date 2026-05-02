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
    if (isNaN(data[i])) continue;
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
    if (isNaN(data[i])) continue;
    let isPivot = true;
    for (let j = -period; j <= period; j++) {
      if (j !== 0 && data[i + j] <= data[i]) { isPivot = false; break; }
    }
    if (isPivot) pivots.push({ index: i, value: data[i] });
  }
  return pivots;
}

function findNearestPivot(
  pivots: Array<{ index: number; value: number }>,
  targetIndex: number,
  tolerance = 10
): { index: number; value: number } | null {
  let best: { index: number; value: number } | null = null;
  let bestDist = Infinity;
  for (const p of pivots) {
    const dist = Math.abs(p.index - targetIndex);
    if (dist <= tolerance && dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

function detectDivergences(
  priceLows: Array<{ index: number; value: number }>,
  priceHighs: Array<{ index: number; value: number }>,
  indLows: Array<{ index: number; value: number }>,
  indHighs: Array<{ index: number; value: number }>,
  indicatorName: string,
  maxLookback = 5
): DivergenceSignal[] {
  const signals: DivergenceSignal[] = [];

  // ✅ Positive Regular: 가격 저점↓, 지표 저점↑ → 강세 반전
  const lastPriceLow = priceLows[priceLows.length - 1];
  const lastIndLow = lastPriceLow ? findNearestPivot(indLows, lastPriceLow.index) : null;
  if (lastPriceLow && lastIndLow) {
    const priorPriceLows = priceLows.slice(0, -1).slice(-maxLookback);
    for (const ppl of priorPriceLows) {
      const matchedIndLow = findNearestPivot(indLows, ppl.index);
      if (!matchedIndLow) continue;
      if (lastPriceLow.value < ppl.value && lastIndLow.value > matchedIndLow.value) {
        const strength = Math.abs(lastIndLow.value - matchedIndLow.value) / (Math.abs(matchedIndLow.value) || 1);
        signals.push({
          indicator: indicatorName,
          type: "positive_regular",
          strength: Math.min(1, strength),
          barIndex: lastPriceLow.index,
          description: `${indicatorName}: Bullish Regular Divergence — price lower low, indicator higher low`
        });
        break;
      }
    }
  }

  // ✅ Negative Regular: 가격 고점↑, 지표 고점↓ → 약세 반전
  const lastPriceHigh = priceHighs[priceHighs.length - 1];
  const lastIndHigh = lastPriceHigh ? findNearestPivot(indHighs, lastPriceHigh.index) : null;
  if (lastPriceHigh && lastIndHigh) {
    const priorPriceHighs = priceHighs.slice(0, -1).slice(-maxLookback);
    for (const pph of priorPriceHighs) {
      const matchedIndHigh = findNearestPivot(indHighs, pph.index);
      if (!matchedIndHigh) continue;
      if (lastPriceHigh.value > pph.value && lastIndHigh.value < matchedIndHigh.value) {
        const strength = Math.abs(lastIndHigh.value - matchedIndHigh.value) / (Math.abs(matchedIndHigh.value) || 1);
        signals.push({
          indicator: indicatorName,
          type: "negative_regular",
          strength: Math.min(1, strength),
          barIndex: lastPriceHigh.index,
          description: `${indicatorName}: Bearish Regular Divergence — price higher high, indicator lower high`
        });
        break;
      }
    }
  }

  // ✅ Positive Hidden: 가격 저점↑, 지표 저점↓ → 강세 지속
  if (lastPriceLow && lastIndLow) {
    const priorPriceLows = priceLows.slice(0, -1).slice(-maxLookback);
    for (const ppl of priorPriceLows) {
      const matchedIndLow = findNearestPivot(indLows, ppl.index);
      if (!matchedIndLow) continue;
      if (lastPriceLow.value > ppl.value && lastIndLow.value < matchedIndLow.value) {
        const strength = Math.abs(lastIndLow.value - matchedIndLow.value) / (Math.abs(matchedIndLow.value) || 1);
        signals.push({
          indicator: indicatorName,
          type: "positive_hidden",
          strength: Math.min(1, strength),
          barIndex: lastPriceLow.index,
          description: `${indicatorName}: Bullish Hidden Divergence — price higher low, indicator lower low`
        });
        break;
      }
    }
  }

  // ✅ Negative Hidden: 가격 고점↓, 지표 고점↑ → 약세 지속
  if (lastPriceHigh && lastIndHigh) {
    const priorPriceHighs = priceHighs.slice(0, -1).slice(-maxLookback);
    for (const pph of priorPriceHighs) {
      const matchedIndHigh = findNearestPivot(indHighs, pph.index);
      if (!matchedIndHigh) continue;
      if (lastPriceHigh.value < pph.value && lastIndHigh.value > matchedIndHigh.value) {
        const strength = Math.abs(lastIndHigh.value - matchedIndHigh.value) / (Math.abs(matchedIndHigh.value) || 1);
        signals.push({
          indicator: indicatorName,
          type: "negative_hidden",
          strength: Math.min(1, strength),
          barIndex: lastPriceHigh.index,
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
    // ✅ 지표의 피벗 고점/저점을 직접 계산하여 detectDivergences에 전달
    const indLows = findPivotLows(ind.data);
    const indHighs = findPivotHighs(ind.data);
    const divs = detectDivergences(priceLows, priceHighs, indLows, indHighs, ind.name);
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
