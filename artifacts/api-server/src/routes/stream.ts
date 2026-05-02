// routes/stream.ts — SSE 엔드포인트 (실시간 다이버전스 신호 스트리밍)

import { Router, Request, Response } from "express";
import {
  realtimeEmitter,
  startWatch,
  stopWatch,
  getWatchList,
  RealtimeSignal,
} from "../lib/realtime";

const router = Router();

// ─── SSE 헬퍼 ─────────────────────────────────────────────────────────────────
function sendEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ─── GET /stream/divergence ───────────────────────────────────────────────────
// 쿼리: ?symbol=BTC/USDT&timeframe=15m
// 특정 심볼+타임프레임 신호만 구독
router.get("/divergence", (req: Request, res: Response) => {
  const symbol = req.query.symbol as string;
  const timeframe = (req.query.timeframe as string) || "15m";

  if (!symbol) {
    res.status(400).json({ error: "symbol required" });
    return;
  }

  // SSE 헤더
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // nginx 버퍼링 비활성화
  res.flushHeaders();

  // 연결 확인 이벤트
  sendEvent(res, "connected", {
    symbol,
    timeframe,
    message: "실시간 다이버전스 스트리밍 시작",
    timestamp: Date.now(),
  });

  // 감시 시작
  startWatch(symbol, timeframe);

  // 신호 수신 핸들러
  const channelKey = `signal:${symbol}::${timeframe}`;
  const onSignal = (signal: RealtimeSignal) => {
    sendEvent(res, "signal", signal);
  };
  realtimeEmitter.on(channelKey, onSignal);

  // 하트비트 (30초마다 연결 유지)
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 30_000);

  // 클라이언트 연결 종료 처리
  req.on("close", () => {
    clearInterval(heartbeat);
    realtimeEmitter.off(channelKey, onSignal);
    // 해당 채널 구독자가 없으면 감시 중지
    const listenerCount = realtimeEmitter.listenerCount(channelKey);
    if (listenerCount === 0) {
      stopWatch(symbol, timeframe);
    }
  });
});

// ─── GET /stream/all ──────────────────────────────────────────────────────────
// 모든 감시 중인 심볼 신호 구독
router.get("/all", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  sendEvent(res, "connected", {
    message: "전체 신호 스트리밍 시작",
    watching: getWatchList(),
    timestamp: Date.now(),
  });

  const onSignal = (signal: RealtimeSignal) => {
    sendEvent(res, "signal", signal);
  };
  realtimeEmitter.on("signal", onSignal);

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 30_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    realtimeEmitter.off("signal", onSignal);
  });
});

// ─── POST /stream/watch ───────────────────────────────────────────────────────
// 감시 심볼 추가
router.post("/watch", (req: Request, res: Response) => {
  const { symbol, timeframe = "15m" } = req.body ?? {};
  if (!symbol) {
    res.status(400).json({ error: "symbol required" });
    return;
  }
  startWatch(symbol, timeframe);
  res.json({ ok: true, symbol, timeframe, watching: getWatchList() });
});

// ─── DELETE /stream/watch ─────────────────────────────────────────────────────
// 감시 심볼 제거
router.delete("/watch", (req: Request, res: Response) => {
  const { symbol, timeframe = "15m" } = req.body ?? {};
  if (!symbol) {
    res.status(400).json({ error: "symbol required" });
    return;
  }
  stopWatch(symbol, timeframe);
  res.json({ ok: true, symbol, timeframe, watching: getWatchList() });
});

// ─── GET /stream/watching ─────────────────────────────────────────────────────
// 현재 감시 목록 조회
router.get("/watching", (_req: Request, res: Response) => {
  res.json({ watching: getWatchList() });
});

export default router;
