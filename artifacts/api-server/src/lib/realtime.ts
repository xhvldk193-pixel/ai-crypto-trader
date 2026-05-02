// lib/realtime.ts — 폴링 기반 실시간 다이버전스 감지 + SSE 브로드캐스트

import { EventEmitter } from "events";
import { exchangeService } from "./exchange";
import { analyzeDivergences } from "./divergence";
import { computeAtrPercent } from "./indicators";
import { logger } from "./logger";

// ─── 타임프레임별 폴링 간격 ────────────────────────────────────────────────────
const POLL_INTERVALS: Record<string, number> = {
  "1m":  10_000,   // 10초
  "3m":  15_000,   // 15초
  "5m":  20_000,   // 20초
  "15m": 30_000,   // 30초
  "30m": 45_000,   // 45초
  "1h":  60_000,   // 1분
  "4h":  120_000,  // 2분
  "1d":  300_000,  // 5분
};

const DEFAULT_POLL_INTERVAL = 30_000;

// ─── 타입 ─────────────────────────────────────────────────────────────────────
export interface RealtimeSignal {
  symbol: string;
  timeframe: string;
  bullishCount: number;
  bearishCount: number;
  overallBias: "bullish" | "bearish" | "neutral";
  signals: Array<{
    indicator: string;
    type: string;
    strength: number;
    barIndex: number;
    description: string;
  }>;
  atrPercent: number | null;
  price: number;
  analyzedAt: number;
}

interface WatchKey {
  symbol: string;
  timeframe: string;
}

interface WatchState {
  symbol: string;
  timeframe: string;
  lastTimestamp: number;   // 마지막으로 본 캔들 timestamp
  lastSignalKey: string;   // 중복 신호 방지
  timer: ReturnType<typeof setInterval> | null;
}

// ─── 이벤트 이미터 (SSE 클라이언트에 브로드캐스트용) ─────────────────────────
export const realtimeEmitter = new EventEmitter();
realtimeEmitter.setMaxListeners(100);

// ─── 감시 상태 관리 ───────────────────────────────────────────────────────────
const watchMap = new Map<string, WatchState>();

function watchKey(symbol: string, timeframe: string): string {
  return `${symbol}::${timeframe}`;
}

// ─── 캔들 폴링 및 다이버전스 감지 ─────────────────────────────────────────────
async function poll(state: WatchState): Promise<void> {
  try {
    const candles = await exchangeService.getOhlcv(state.symbol, state.timeframe, 200);
    if (candles.length < 60) return;

    const latest = candles[candles.length - 1];

    // 새 봉이 닫혔는지 확인 (timestamp 변화)
    // 봉이 닫히지 않았어도 분석은 수행하되 중복 신호 방지
    const div = analyzeDivergences(candles, state.symbol, state.timeframe, { dontConfirm: true });

    // 신호가 없으면 스킵
    if (div.bullishCount === 0 && div.bearishCount === 0) {
      state.lastTimestamp = latest.timestamp;
      return;
    }

    // 중복 신호 방지: 같은 봉 + 같은 bias면 스킵
    const signalKey = `${latest.timestamp}::${div.overallBias}::${div.bullishCount}::${div.bearishCount}`;
    if (signalKey === state.lastSignalKey) return;
    state.lastSignalKey = signalKey;
    state.lastTimestamp = latest.timestamp;

    // ATR 계산
    const atrPercent = computeAtrPercent(candles, 14);

    // 현재가
    let price = latest.close;
    try {
      const ticker = await exchangeService.getTicker(state.symbol);
      price = ticker.price;
    } catch { /* 최신 종가로 대체 */ }

    const signal: RealtimeSignal = {
      symbol: state.symbol,
      timeframe: state.timeframe,
      bullishCount: div.bullishCount,
      bearishCount: div.bearishCount,
      overallBias: div.overallBias,
      signals: div.signals,
      atrPercent,
      price,
      analyzedAt: Date.now(),
    };

    // 전체 구독자에게 브로드캐스트
    realtimeEmitter.emit("signal", signal);

    // 심볼+타임프레임 특정 구독자에게도 emit
    realtimeEmitter.emit(`signal:${watchKey(state.symbol, state.timeframe)}`, signal);

    logger.info(
      { symbol: state.symbol, timeframe: state.timeframe, bias: div.overallBias, bullish: div.bullishCount, bearish: div.bearishCount },
      "실시간 다이버전스 감지"
    );
  } catch (err) {
    logger.warn({ err, symbol: state.symbol, timeframe: state.timeframe }, "폴링 실패");
  }
}

// ─── 감시 시작 ────────────────────────────────────────────────────────────────
export function startWatch(symbol: string, timeframe: string): void {
  const key = watchKey(symbol, timeframe);
  if (watchMap.has(key)) return; // 이미 감시 중

  const interval = POLL_INTERVALS[timeframe] ?? DEFAULT_POLL_INTERVAL;
  const state: WatchState = {
    symbol,
    timeframe,
    lastTimestamp: 0,
    lastSignalKey: "",
    timer: null,
  };

  // 즉시 1회 실행
  poll(state);

  state.timer = setInterval(() => poll(state), interval);
  watchMap.set(key, state);

  logger.info({ symbol, timeframe, interval }, "실시간 감시 시작");
}

// ─── 감시 중지 ────────────────────────────────────────────────────────────────
export function stopWatch(symbol: string, timeframe: string): void {
  const key = watchKey(symbol, timeframe);
  const state = watchMap.get(key);
  if (!state) return;

  if (state.timer) clearInterval(state.timer);
  watchMap.delete(key);

  logger.info({ symbol, timeframe }, "실시간 감시 중지");
}

// ─── 현재 감시 목록 ───────────────────────────────────────────────────────────
export function getWatchList(): WatchKey[] {
  return Array.from(watchMap.values()).map((s) => ({
    symbol: s.symbol,
    timeframe: s.timeframe,
  }));
}

// ─── 모든 감시 중지 ───────────────────────────────────────────────────────────
export function stopAllWatch(): void {
  for (const [key, state] of watchMap.entries()) {
    if (state.timer) clearInterval(state.timer);
    watchMap.delete(key);
  }
  logger.info("모든 실시간 감시 중지");
}
