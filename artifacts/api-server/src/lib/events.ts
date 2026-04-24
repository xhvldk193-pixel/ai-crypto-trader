// artifacts/api-server/src/lib/events.ts
// 봇 내부 이벤트를 SSE 등 외부 구독자에게 전달하기 위한 경량 pub/sub.
// Node의 EventEmitter 기반이므로 단일 프로세스 내에서만 동작.
// 여러 인스턴스 확장 시에는 Redis pub/sub 등으로 교체 필요.

import { EventEmitter } from "node:events";

export interface BotLogEvent {
  type: "log";
  level: string;
  message: string;
  symbol?: string | null;
  action?: string | null;
  timestamp: number;
}

export interface BotStatusEvent {
  type: "status";
  running: boolean;
  symbols: string[];
  timeframe: string;
  lastSignal: string;
  lastCheckedAt?: number;
  totalSignals: number;
  executedTrades: number;
  dailyPnlUsd: number;
  dailyPnlPercent: number;
  halted: boolean;
  timestamp: number;
}

export interface BotPositionEvent {
  type: "position";
  action: "opened" | "closed" | "partial-tp" | "trailing-updated";
  symbol: string;
  side: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export type BotEvent = BotLogEvent | BotStatusEvent | BotPositionEvent;

class BotEventBus extends EventEmitter {
  emitLog(e: Omit<BotLogEvent, "type" | "timestamp">) {
    const evt: BotLogEvent = { type: "log", timestamp: Date.now(), ...e };
    this.emit("event", evt);
  }
  emitStatus(e: Omit<BotStatusEvent, "type" | "timestamp">) {
    const evt: BotStatusEvent = { type: "status", timestamp: Date.now(), ...e };
    this.emit("event", evt);
  }
  emitPosition(e: Omit<BotPositionEvent, "type" | "timestamp">) {
    const evt: BotPositionEvent = { type: "position", timestamp: Date.now(), ...e };
    this.emit("event", evt);
  }
}

export const botEvents = new BotEventBus();
// EventEmitter의 기본 리스너 한도는 10 — SSE 다중 탭에서 경고가 나지 않게 확장
botEvents.setMaxListeners(50);
