// divergence.ts — TradingView "Divergence for Many Indicators v4" exact port
// Original by LonesomeTheBlue, ported to TypeScript

export type Candle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type DivergenceSignal = {
  indicator: string;
  type: "positive_regular" | "negative_regular" | "positive_hidden" | "negative_hidden";
  strength: number;
  barIndex: number;
  description: string;
};

// ─── CONFIG (트레이딩뷰 기본값과 동일) ────────────────────────────────────────
const PRD = 5;           // Pivot Period
const MAX_PP = 10;       // Maximum Pivot Points to Check
const MAX_BARS = 100;    // Maximum Bars to Check
const SOURCE = "Close";  // "Close" | "High/Low"
const DONT_CONFIRM = false; // Don't Wait for Confirmation

// ─── RSI (Wilder's RMA smoothing — TradingView rsi() 동일) ───────────────────
function computeRsi(closes: number[], period = 14): number[] {
  const result = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

// ─── EMA ─────────────────────────────────────────────────────────────────────
function computeEma(data: number[], period: number): number[] {
  const result = new Array(data.length).fill(NaN);
  const k = 2 / (period + 1);
  let startIdx = data.findIndex((v) => !isNaN(v));
  if (startIdx === -1 || data.length - startIdx < period) return result;

  let sum = 0;
  for (let i = startIdx; i < startIdx + period; i++) sum += data[i];
  result[startIdx + period - 1] = sum / period;

  for (let i = startIdx + period; i < data.length; i++) {
    result[i] = data[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

// ─── SMA ─────────────────────────────────────────────────────────────────────
function computeSma(data: number[], period: number): number[] {
  const result = new Array(data.length).fill(NaN);
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (!isNaN(data[j])) { sum += data[j]; count++; }
    }
    if (count === period) result[i] = sum / period;
  }
  return result;
}

// ─── MACD (line + histogram — TV: macd(close,12,26,9)) ───────────────────────
function computeMacdLine(closes: number[]): number[] {
  const ema12 = computeEma(closes, 12);
  const ema26 = computeEma(closes, 26);
  return closes.map((_, i) =>
    isNaN(ema12[i]) || isNaN(ema26[i]) ? NaN : ema12[i] - ema26[i]
  );
}

function computeMacdHistogram(closes: number[]): number[] {
  const macdLine = computeMacdLine(closes);
  const signal = computeEma(macdLine, 9);
  return macdLine.map((v, i) =>
    isNaN(v) || isNaN(signal[i]) ? NaN : v - signal[i]
  );
}

// ─── OBV (TV: obv 내장) ──────────────────────────────────────────────────────
function computeObv(closes: number[], volumes: number[]): number[] {
  const result = new Array(closes.length).fill(NaN);
  result[0] = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) result[i] = result[i - 1] + volumes[i];
    else if (closes[i] < closes[i - 1]) result[i] = result[i - 1] - volumes[i];
    else result[i] = result[i - 1];
  }
  return result;
}

// ─── Momentum (TV: mom(close,10)) ────────────────────────────────────────────
function computeMom(closes: number[], period = 10): number[] {
  const result = new Array(closes.length).fill(NaN);
  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] - closes[i - period];
  }
  return result;
}

// ─── CCI (TV: cci(close,10)) ─────────────────────────────────────────────────
function computeCci(
  closes: number[],
  highs: number[],
  lows: number[],
  period = 10
): number[] {
  const result = new Array(closes.length).fill(NaN);
  const tp = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = tp.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const mad = slice.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
    result[i] = mad === 0 ? 0 : (tp[i] - mean) / (0.015 * mad);
  }
  return result;
}

// ─── Stochastic (TV: sma(stoch(close,high,low,14),3)) ────────────────────────
function computeStoch(
  closes: number[],
  highs: number[],
  lows: number[],
  period = 14,
  smoothK = 3
): number[] {
  const rawK = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    const sliceH = highs.slice(i - period + 1, i + 1);
    const sliceL = lows.slice(i - period + 1, i + 1);
    const hh = Math.max(...sliceH);
    const ll = Math.min(...sliceL);
    rawK[i] = hh === ll ? 0 : ((closes[i] - ll) / (hh - ll)) * 100;
  }
  return computeSma(rawK, smoothK);
}

// ─── VWmacd (TV: vwma(close,12) - vwma(close,26)) ────────────────────────────
function computeVwma(closes: number[], volumes: number[], period: number): number[] {
  const result = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    let sumCV = 0, sumV = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumCV += closes[j] * volumes[j];
      sumV += volumes[j];
    }
    result[i] = sumV === 0 ? NaN : sumCV / sumV;
  }
  return result;
}

function computeVwmacd(closes: number[], volumes: number[]): number[] {
  const fast = computeVwma(closes, volumes, 12);
  const slow = computeVwma(closes, volumes, 26);
  return closes.map((_, i) =>
    isNaN(fast[i]) || isNaN(slow[i]) ? NaN : fast[i] - slow[i]
  );
}

// ─── CMF (TV: Chaikin Money Flow, period=21) ─────────────────────────────────
function computeCmf(
  closes: number[],
  highs: number[],
  lows: number[],
  volumes: number[],
  period = 21
): number[] {
  const cmfm = closes.map((c, i) => {
    const hl = highs[i] - lows[i];
    return hl === 0 ? 0 : ((c - lows[i]) - (highs[i] - c)) / hl;
  });
  const cmfv = cmfm.map((m, i) => m * volumes[i]);
  const sumCmfv = computeSma(cmfv.map((v, i) => v * period), period); // trick: use raw sum via sma*period
  const sumVol = computeSma(volumes.map((v) => v), period);

  // 정확한 rolling sum
  const result = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    let sCmfv = 0, sVol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sCmfv += cmfv[j];
      sVol += volumes[j];
    }
    result[i] = sVol === 0 ? 0 : sCmfv / sVol;
  }
  return result;
}

// ─── MFI (TV: mfi(close,14)) ─────────────────────────────────────────────────
function computeMfi(
  closes: number[],
  highs: number[],
  lows: number[],
  volumes: number[],
  period = 14
): number[] {
  const result = new Array(closes.length).fill(NaN);
  const tp = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  for (let i = period; i < closes.length; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const mf = tp[j] * volumes[j];
      if (tp[j] > tp[j - 1]) posFlow += mf;
      else negFlow += mf;
    }
    result[i] = negFlow === 0 ? 100 : 100 - 100 / (1 + posFlow / negFlow);
  }
  return result;
}

// ─── Pivot High/Low 배열 구성 (TV: pivothigh/pivotlow 동일 방식) ──────────────
// TV는 bar_index 기준으로 저장. 여기선 배열 index로 대체.
type Pivot = { index: number; value: number };

function buildPivotHighs(
  data: number[],       // source (close or high)
  prd: number
): Pivot[] {
  // TV: pivothigh(src, prd, prd) → prd봉 좌우에서 최고점
  // confirmed: i+prd까지 봐야 확정되므로 마지막 prd봉은 미확정
  const pivots: Pivot[] = [];
  for (let i = prd; i < data.length - prd; i++) {
    if (isNaN(data[i])) continue;
    let isPivot = true;
    for (let j = 1; j <= prd; j++) {
      if (data[i - j] >= data[i] || data[i + j] >= data[i]) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) pivots.push({ index: i, value: data[i] });
  }
  return pivots;
}

function buildPivotLows(
  data: number[],
  prd: number
): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = prd; i < data.length - prd; i++) {
    if (isNaN(data[i])) continue;
    let isPivot = true;
    for (let j = 1; j <= prd; j++) {
      if (data[i - j] <= data[i] || data[i + j] <= data[i]) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) pivots.push({ index: i, value: data[i] });
  }
  return pivots;
}

// ─── 핵심: virtual_line 검증 포함 다이버전스 감지 ─────────────────────────────
// TV 원본 positive_regular_positive_hidden_divergence() 함수 그대로 포팅
// cond=1 → positive_regular, cond=2 → positive_hidden
function positiveRegularOrHidden(
  src: number[],          // 인디케이터 값 배열
  closes: number[],       // 가격 종가 배열
  highs: number[],
  lows: number[],
  plPositions: Pivot[],   // Pivot Low 배열 (bar_index 순 내림차순, TV array.unshift 방식)
  barIdx: number,         // 현재 bar index (배열 끝)
  cond: 1 | 2
): number {
  // TV: startpoint = dontconfirm ? 0 : 1
  const startpoint = DONT_CONFIRM ? 0 : 1;
  const currentBar = barIdx - startpoint;
  const srcCurrent = src[currentBar];
  const closeCurrent = closes[currentBar];

  // TV: if dontconfirm or src > src[1] or close > close[1]
  const srcPrev = src[currentBar - 1] ?? NaN;
  const closePrev = closes[currentBar - 1] ?? NaN;
  const conditionMet =
    DONT_CONFIRM ||
    srcCurrent > srcPrev ||
    closeCurrent > closePrev;

  if (!conditionMet) return 0;

  // prsc = source == "Close" ? close : low
  const prsc = SOURCE === "Close" ? closes : lows;

  for (let x = 0; x < Math.min(plPositions.length, MAX_PP); x++) {
    const pivotBarIdx = plPositions[x].index;
    const len = barIdx - pivotBarIdx + PRD; // TV: bar_index - array.get(pl_positions, x) + prd

    if (pivotBarIdx === 0 || len > MAX_BARS) break;
    if (len <= 5) continue;

    const srcAtPivot = src[barIdx - len] ?? NaN;
    const prscAtPivot = prsc[barIdx - len] ?? NaN;
    const plVal = plPositions[x].value;

    const divCondition =
      cond === 1
        ? srcCurrent > srcAtPivot && prsc[currentBar] < plVal      // positive regular
        : srcCurrent < srcAtPivot && prsc[currentBar] > plVal;     // positive hidden

    if (!divCondition) continue;

    // ── virtual_line 검증 (TV 핵심 로직) ──────────────────────────────────
    const slope1 = (srcCurrent - srcAtPivot) / (len - startpoint);
    let vLine1 = srcCurrent - slope1;

    const slope2 = (closeCurrent - closes[barIdx - len]) / (len - startpoint);
    let vLine2 = closeCurrent - slope2;

    let arrived = true;
    for (let y = 1 + startpoint; y <= len - 1; y++) {
      const srcY = src[barIdx - y] ?? NaN;
      const closeY = closes[barIdx - y] ?? NaN;

      if (srcY < vLine1 || closeY < vLine2) {
        arrived = false;
        break;
      }
      vLine1 -= slope1;
      vLine2 -= slope2;
    }

    if (arrived) return len;
  }

  return 0;
}

// TV 원본 negative_regular_negative_hidden_divergence() 포팅
// cond=1 → negative_regular, cond=2 → negative_hidden
function negativeRegularOrHidden(
  src: number[],
  closes: number[],
  highs: number[],
  lows: number[],
  phPositions: Pivot[],
  barIdx: number,
  cond: 1 | 2
): number {
  const startpoint = DONT_CONFIRM ? 0 : 1;
  const currentBar = barIdx - startpoint;
  const srcCurrent = src[currentBar];
  const closeCurrent = closes[currentBar];

  const srcPrev = src[currentBar - 1] ?? NaN;
  const closePrev = closes[currentBar - 1] ?? NaN;
  const conditionMet =
    DONT_CONFIRM ||
    srcCurrent < srcPrev ||
    closeCurrent < closePrev;

  if (!conditionMet) return 0;

  const prsc = SOURCE === "Close" ? closes : highs;

  for (let x = 0; x < Math.min(phPositions.length, MAX_PP); x++) {
    const pivotBarIdx = phPositions[x].index;
    const len = barIdx - pivotBarIdx + PRD;

    if (pivotBarIdx === 0 || len > MAX_BARS) break;
    if (len <= 5) continue;

    const srcAtPivot = src[barIdx - len] ?? NaN;
    const prscAtPivot = prsc[barIdx - len] ?? NaN;
    const phVal = phPositions[x].value;

    const divCondition =
      cond === 1
        ? srcCurrent < srcAtPivot && prsc[currentBar] > phVal      // negative regular
        : srcCurrent > srcAtPivot && prsc[currentBar] < phVal;     // negative hidden

    if (!divCondition) continue;

    // ── virtual_line 검증 ──────────────────────────────────────────────────
    const slope1 = (srcCurrent - srcAtPivot) / (len - startpoint);
    let vLine1 = srcCurrent - slope1;

    const slope2 = (closeCurrent - closes[barIdx - len]) / (len - startpoint);
    let vLine2 = closeCurrent - slope2;

    let arrived = true;
    for (let y = 1 + startpoint; y <= len - 1; y++) {
      const srcY = src[barIdx - y] ?? NaN;
      const closeY = closes[barIdx - y] ?? NaN;

      if (srcY > vLine1 || closeY > vLine2) {
        arrived = false;
        break;
      }
      vLine1 -= slope1;
      vLine2 -= slope2;
    }

    if (arrived) return len;
  }

  return 0;
}

// ─── 인디케이터별 4종 다이버전스 계산 ────────────────────────────────────────
function calculateDivs(
  src: number[],
  closes: number[],
  highs: number[],
  lows: number[],
  plPositions: Pivot[],
  phPositions: Pivot[],
  barIdx: number
): [number, number, number, number] {
  return [
    positiveRegularOrHidden(src, closes, highs, lows, plPositions, barIdx, 1), // positive_regular
    negativeRegularOrHidden(src, closes, highs, lows, phPositions, barIdx, 1), // negative_regular
    positiveRegularOrHidden(src, closes, highs, lows, plPositions, barIdx, 2), // positive_hidden
    negativeRegularOrHidden(src, closes, highs, lows, phPositions, barIdx, 2), // negative_hidden
  ];
}

// ─── 메인 분석 함수 ───────────────────────────────────────────────────────────
export function analyzeDivergences(
  candles: Candle[],
  symbol: string,
  timeframe: string
) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  // 인디케이터 계산
  const rsi = computeRsi(closes, 14);
  const macdLine = computeMacdLine(closes);
  const macdHist = computeMacdHistogram(closes);
  const obv = computeObv(closes, volumes);
  const mom = computeMom(closes, 10);
  const cci = computeCci(closes, highs, lows, 10);
  const stoch = computeStoch(closes, highs, lows, 14, 3);
  const vwmacd = computeVwmacd(closes, volumes);
  const cmf = computeCmf(closes, highs, lows, volumes, 21);
  const mfi = computeMfi(closes, highs, lows, volumes, 14);

  // 피벗 소스: TV SOURCE="Close" 기준
  const pivotSrc = SOURCE === "Close" ? closes : closes; // High/Low 옵션은 highs/lows
  const phPivots = buildPivotHighs(pivotSrc, PRD);
  const plPivots = buildPivotLows(pivotSrc, PRD);

  // TV는 최신 피벗이 앞에 오도록 unshift → reverse()로 동일하게
  const plDesc = [...plPivots].reverse();
  const phDesc = [...phPivots].reverse();

  const barIdx = closes.length - 1;

  const indicators: Array<{ name: string; data: number[] }> = [
    { name: "MACD",   data: macdLine },
    { name: "Hist",   data: macdHist },
    { name: "RSI",    data: rsi },
    { name: "Stoch",  data: stoch },
    { name: "CCI",    data: cci },
    { name: "MOM",    data: mom },
    { name: "OBV",    data: obv },
    { name: "VWMACD", data: vwmacd },
    { name: "CMF",    data: cmf },
    { name: "MFI",    data: mfi },
  ];

  const signals: DivergenceSignal[] = [];

  for (const ind of indicators) {
    const [posReg, negReg, posHid, negHid] = calculateDivs(
      ind.data,
      closes,
      highs,
      lows,
      plDesc,
      phDesc,
      barIdx
    );

    const typeMap: Array<[number, DivergenceSignal["type"], string]> = [
      [posReg, "positive_regular", "Bullish Regular Divergence"],
      [negReg, "negative_regular", "Bearish Regular Divergence"],
      [posHid, "positive_hidden",  "Bullish Hidden Divergence"],
      [negHid, "negative_hidden",  "Bearish Hidden Divergence"],
    ];

    for (const [len, type, desc] of typeMap) {
      if (len > 0) {
        signals.push({
          indicator: ind.name,
          type,
          strength: len, // TV는 strength 개념 없음 → len(거리)으로 대체
          barIndex: barIdx,
          description: `${ind.name}: ${desc}`,
        });
      }
    }
  }

  const bullishCount = signals.filter(
    (s) => s.type === "positive_regular" || s.type === "positive_hidden"
  ).length;
  const bearishCount = signals.filter(
    (s) => s.type === "negative_regular" || s.type === "negative_hidden"
  ).length;

  const overallBias: "bullish" | "bearish" | "neutral" =
    bullishCount > bearishCount
      ? "bullish"
      : bearishCount > bullishCount
      ? "bearish"
      : "neutral";

  return {
    symbol,
    timeframe,
    signals,
    bullishCount,
    bearishCount,
    overallBias,
    analyzedAt: Date.now(),
  };
}
