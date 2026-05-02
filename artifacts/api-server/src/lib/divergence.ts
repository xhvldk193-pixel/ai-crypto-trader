// Divergence analysis — Original structure with Hidden Divergences removed

export type Candle = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };

type DivergenceSignal = {
  indicator: string;
  type: "positive_regular" | "negative_regular" | "positive_hidden" | "negative_hidden";
  strength: number;
  barIndex: number;
  description: string;
};

// ... (computeRsi, sma, ema, computeMacd, computeObv, computeMom, computeCci 함수는 원본과 동일)

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

  // ✅ Positive Regular (상승 반전)만 남김
  const lastPriceLow = priceLows[priceLows.length - 1];
  const lastIndLow = lastPriceLow ? findNearestPivot(indLows, lastPriceLow.index) : null;
  if (lastPriceLow && lastIndLow) {
    const priorPriceLows = priceLows.slice(0, -1).slice(-maxLookback);
    for (const ppl of priorPriceLows) {
      const matchedIndLow = findNearestPivot(indLows, ppl.index);
      if (!matchedIndLow) continue;
      if (lastPriceLow.value < ppl.value && lastIndLow.value > matchedIndLow.value) {
        signals.push({
          indicator: indicatorName,
          type: "positive_regular",
          strength: Math.abs(lastIndLow.value - matchedIndLow.value) / (Math.abs(matchedIndLow.value) || 1),
          barIndex: lastPriceLow.index,
          description: `${indicatorName}: Bullish Regular Divergence`
        });
        break;
      }
    }
  }

  // ✅ Negative Regular (하락 반전)만 남김
  const lastPriceHigh = priceHighs[priceHighs.length - 1];
  const lastIndHigh = lastPriceHigh ? findNearestPivot(indHighs, lastPriceHigh.index) : null;
  if (lastPriceHigh && lastIndHigh) {
    const priorPriceHighs = priceHighs.slice(0, -1).slice(-maxLookback);
    for (const pph of priorPriceHighs) {
      const matchedIndHigh = findNearestPivot(indHighs, pph.index);
      if (!matchedIndHigh) continue;
      if (lastPriceHigh.value > pph.value && lastIndHigh.value < matchedIndHigh.value) {
        signals.push({
          indicator: indicatorName,
          type: "negative_regular",
          strength: Math.abs(lastIndHigh.value - matchedIndHigh.value) / (Math.abs(matchedIndHigh.value) || 1),
          barIndex: lastPriceHigh.index,
          description: `${indicatorName}: Bearish Regular Divergence`
        });
        break;
      }
    }
  }

  // ❌ 히든 다이버전스 로직(Positive Hidden, Negative Hidden)은 모두 제거되었습니다.

  return signals;
}

export function analyzeDivergences(candles: Candle[], symbol: string, timeframe: string) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const priceLows = findPivotLows(closes);
  const priceHighs = findPivotHighs(closes);

  const indicators = [
    { name: "RSI", data: computeRsi(closes) },
    { name: "MACD", data: computeMacd(closes) },
    { name: "OBV", data: computeObv(closes, volumes) },
    { name: "MOM", data: computeMom(closes) },
    { name: "CCI", data: computeCci(closes, highs, lows) },
  ];

  const allSignals: DivergenceSignal[] = [];
  for (const ind of indicators) {
    const indLows = findPivotLows(ind.data);
    const indHighs = findPivotHighs(ind.data);
    const divs = detectDivergences(priceLows, priceHighs, indLows, indHighs, ind.name);
    allSignals.push(...divs);
  }

  // 집계 로직 (히든은 어차피 발생하지 않으므로 filter에서 걸러짐)
  const bullishCount = allSignals.filter(s => s.type === "positive_regular").length;
  const bearishCount = allSignals.filter(s => s.type === "negative_regular").length;
  
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
