// Divergence analysis — Regular Divergence Only (Hidden Removed)

export type Candle = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };

type DivergenceSignal = {
  indicator: string;
  type: "bullish_regular" | "bearish_regular"; // 히든 타입 삭제
  strength: number;
  barIndex: number;
  description: string;
};

// ... (computeRsi, sma, ema, computeMacd, computeObv, computeMom, computeCci 함수는 동일)

function detectDivergences(
  priceLows: Array<{ index: number; value: number }>,
  priceHighs: Array<{ index: number; value: number }>,
  indLows: Array<{ index: number; value: number }>,
  indHighs: Array<{ index: number; value: number }>,
  indicatorName: string,
  maxLookback = 5
): DivergenceSignal[] {
  const signals: DivergenceSignal[] = [];
  const MIN_STRENGTH = 0.03;

  // ✅ Bullish Regular (강세 반전 - BUY 신호)
  // 가격은 더 낮아졌는데(Lower Low), 지표는 더 높아졌을 때(Higher Low)
  const lastPriceLow = priceLows[priceLows.length - 1];
  const lastIndLow = lastPriceLow ? findNearestPivot(indLows, lastPriceLow.index) : null;
  
  if (lastPriceLow && lastIndLow) {
    const priorPriceLows = priceLows.slice(0, -1).slice(-maxLookback);
    for (const ppl of priorPriceLows) {
      const matchedIndLow = findNearestPivot(indLows, ppl.index);
      if (!matchedIndLow) continue;
      
      if (lastPriceLow.value < ppl.value && lastIndLow.value > matchedIndLow.value) {
        const strength = Math.abs(lastIndLow.value - matchedIndLow.value) / (Math.abs(matchedIndLow.value) || 1);
        if (strength >= MIN_STRENGTH) {
          signals.push({
            indicator: indicatorName,
            type: "bullish_regular",
            strength: Math.min(1, strength),
            barIndex: lastPriceLow.index,
            description: `${indicatorName}: Bullish Regular (Buy)`
          });
          break;
        }
      }
    }
  }

  // ✅ Bearish Regular (약세 반전 - SELL 신호)
  // 가격은 더 높아졌는데(Higher High), 지표는 더 낮아졌을 때(Lower High)
  const lastPriceHigh = priceHighs[priceHighs.length - 1];
  const lastIndHigh = lastPriceHigh ? findNearestPivot(indHighs, lastPriceHigh.index) : null;

  if (lastPriceHigh && lastIndHigh) {
    const priorPriceHighs = priceHighs.slice(0, -1).slice(-maxLookback);
    for (const pph of priorPriceHighs) {
      const matchedIndHigh = findNearestPivot(indHighs, pph.index);
      if (!matchedIndHigh) continue;

      if (lastPriceHigh.value > pph.value && lastIndHigh.value < matchedIndHigh.value) {
        const strength = Math.abs(lastIndHigh.value - matchedIndHigh.value) / (Math.abs(matchedIndHigh.value) || 1);
        if (strength >= MIN_STRENGTH) {
          signals.push({
            indicator: indicatorName,
            type: "bearish_regular",
            strength: Math.min(1, strength),
            barIndex: lastPriceHigh.index,
            description: `${indicatorName}: Bearish Regular (Sell)`
          });
          break;
        }
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

  const bullishCount = allSignals.filter(s => s.type === "bullish_regular").length;
  const bearishCount = allSignals.filter(s => s.type === "bearish_regular").length;

  let overallBias: "bullish" | "bearish" | "neutral" = "neutral";
  if (bullishCount > bearishCount) overallBias = "bullish";
  else if (bearishCount > bullishCount) overallBias = "bearish";

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
