import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { botConfigTable, botLogsTable, tradeHistoryTable, tradeReflectionsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { botManager } from "../lib/botManager";
import { botEvents, type BotEvent } from "../lib/events";

const router = Router();

// ─────────────────────────────────────────────────────
// 유효성 검증 헬퍼
// ─────────────────────────────────────────────────────

function parseLimit(raw: unknown, defaultVal: number, maxVal: number): number {
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return defaultVal;
  return Math.min(n, maxVal);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function toFiniteNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function setIfValidNumber(
  target: Record<string, unknown>,
  key: string,
  raw: unknown,
  opts: { min?: number; max?: number; integer?: boolean } = {}
) {
  const n = toFiniteNumber(raw);
  if (n === null) return;
  if (opts.min !== undefined && n < opts.min) return;
  if (opts.max !== undefined && n > opts.max) return;
  target[key] = opts.integer ? Math.floor(n) : n;
}

function setIfValidString(
  target: Record<string, unknown>,
  key: string,
  raw: unknown,
  allowed?: string[]
) {
  if (!isNonEmptyString(raw)) return;
  const val = raw.trim();
  if (allowed && !allowed.includes(val)) return;
  target[key] = val;
}

const ALLOWED_TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"];
const ALLOWED_ENTRY_MODES = ["fixed", "full"];
const ALLOWED_MARGIN_TYPES = ["ISOLATED", "CROSSED"];

// ─────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────

router.get("/status", async (_req, res) => {
  const status = botManager.getStatus();
  res.json(status);
});

// ─────────────────────────────────────────────────────
// SSE — 봇 상태/로그/포지션 이벤트를 실시간 스트리밍
// 클라이언트: const es = new EventSource('/api/bot/stream')
// 이벤트 타입은 data 페이로드의 `type` 필드로 구분 (log | status | position)
// ─────────────────────────────────────────────────────
router.get("/stream", (req: Request, res: Response) => {
  // SSE 헤더
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // nginx 버퍼링 비활성
  res.flushHeaders();

  // 연결 직후 현재 상태 스냅샷 1회 전송
  const snapshot = {
    type: "status" as const,
    ...botManager.getStatus(),
    timestamp: Date.now(),
  };
  res.write(`data: ${JSON.stringify(snapshot)}\n\n`);

  // 이벤트 구독
  const listener = (evt: BotEvent) => {
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch { /* 연결이 이미 닫혔을 수 있음 — close 핸들러가 정리 */ }
  };
  botEvents.on("event", listener);

  // 15초마다 heartbeat — 프록시 타임아웃 방지
  const heartbeat = setInterval(() => {
    try { res.write(`: heartbeat\n\n`); } catch { /* ignore */ }
  }, 15_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    botEvents.off("event", listener);
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
});

router.post("/start", async (_req, res) => {
  await botManager.start();
  res.json(botManager.getStatus());
});

router.post("/stop", async (_req, res) => {
  botManager.stop();
  res.json(botManager.getStatus());
});

router.post("/sync-positions", async (req, res) => {
  try {
    const result = await botManager.syncWithExchange();
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to sync positions");
    const msg = err instanceof Error ? err.message : "Failed to sync positions";
    res.status(500).json({ error: msg });
  }
});

router.get("/config", async (req, res) => {
  try {
    const rows = await db.select().from(botConfigTable).limit(1);
    if (rows.length === 0) {
      const [created] = await db.insert(botConfigTable).values({}).returning();
      res.json(configToResponse(created));
      return;
    }
    res.json(configToResponse(rows[0]));
  } catch (err) {
    req.log.error({ err }, "Failed to get bot config");
    res.status(500).json({ error: "Failed to get bot config" });
  }
});

router.put("/config", async (req, res) => {
  try {
    const rows = await db.select().from(botConfigTable).limit(1);
    const body = req.body ?? {};
    const updateData: Record<string, unknown> = {};

    // 문자열 필드 (엄격 검증)
    setIfValidString(updateData, "symbol", body.symbol);
    setIfValidString(updateData, "timeframe", body.timeframe, ALLOWED_TIMEFRAMES);
    setIfValidString(updateData, "entryMode", body.entryMode, ALLOWED_ENTRY_MODES);
    setIfValidString(updateData, "marginType", body.marginType?.toString().toUpperCase(), ALLOWED_MARGIN_TYPES);

    // watchSymbols 배열
    if (body.watchSymbols !== undefined && Array.isArray(body.watchSymbols)) {
      const cleaned = (body.watchSymbols as unknown[])
        .filter((s): s is string => isNonEmptyString(s))
        .map((s) => s.trim());
      const unique = Array.from(new Set(cleaned));
      if (unique.length > 0) {
        updateData.watchSymbols = unique;
      } else {
        // ✅ fallback: body.symbol → 기존 DB symbol → 기본값
        const fallback =
          (isNonEmptyString(body.symbol) && body.symbol.trim()) ||
          (rows.length > 0 ? rows[0].symbol : "BTC/USDT");
        updateData.watchSymbols = [fallback];
      }
    }

    // mtfTimeframes 배열
    if (body.mtfTimeframes !== undefined && Array.isArray(body.mtfTimeframes)) {
      const cleaned = (body.mtfTimeframes as unknown[])
        .filter((t): t is string => isNonEmptyString(t))
        .map((t) => t.trim())
        .filter((t) => ALLOWED_TIMEFRAMES.includes(t));
      updateData.mtfTimeframes = Array.from(new Set(cleaned));
    }

    // enabledIndicators 배열
    if (body.enabledIndicators !== undefined && Array.isArray(body.enabledIndicators)) {
      const cleaned = (body.enabledIndicators as unknown[])
        .filter((s): s is string => isNonEmptyString(s))
        .map((s) => s.trim());
      updateData.enabledIndicators = Array.from(new Set(cleaned));
    }

    // 숫자 필드 (범위 검증 포함)
    setIfValidNumber(updateData, "tradeAmount", body.tradeAmount, { min: 0 });
    setIfValidNumber(updateData, "maxPositions", body.maxPositions, { min: 1, max: 100, integer: true });
    setIfValidNumber(updateData, "stopLossPercent", body.stopLossPercent, { min: 0, max: 100 });
    setIfValidNumber(updateData, "takeProfitPercent", body.takeProfitPercent, { min: 0, max: 100 });
    setIfValidNumber(updateData, "minConfidence", body.minConfidence, { min: 0, max: 1 });
    setIfValidNumber(updateData, "checkIntervalSeconds", body.checkIntervalSeconds, { min: 5, max: 3600, integer: true });
    setIfValidNumber(updateData, "maxDailyLossPercent", body.maxDailyLossPercent, { min: 0, max: 100 });
    setIfValidNumber(updateData, "leverage", body.leverage, { min: 1, max: 125, integer: true });
    setIfValidNumber(updateData, "trailingActivatePercent", body.trailingActivatePercent, { min: 0.01, max: 50 });
    setIfValidNumber(updateData, "trailingDistancePercent", body.trailingDistancePercent, { min: 0.01, max: 50 });
    setIfValidNumber(updateData, "partialTpPercent", body.partialTpPercent, { min: 10, max: 90 });

    // Boolean 필드
    if (body.autoTrade !== undefined) updateData.autoTrade = Boolean(body.autoTrade);
    if (body.useAiTargets !== undefined) updateData.useAiTargets = Boolean(body.useAiTargets);
    if (body.useMtfFilter !== undefined) updateData.useMtfFilter = Boolean(body.useMtfFilter);
    if (body.strictMtf !== undefined) updateData.strictMtf = Boolean(body.strictMtf);
    if (body.useFundingRate !== undefined) updateData.useFundingRate = Boolean(body.useFundingRate);
    if (body.notifyOnError !== undefined) updateData.notifyOnError = Boolean(body.notifyOnError);
    if (body.useTrailingStop !== undefined) updateData.useTrailingStop = Boolean(body.useTrailingStop);
    if (body.usePartialTp !== undefined) updateData.usePartialTp = Boolean(body.usePartialTp);
    if (body.paperTrading !== undefined) updateData.paperTrading = Boolean(body.paperTrading);

    // ── 반대 신호 조기 청산
    if (body.useEarlyExitOnOpposite !== undefined) updateData.useEarlyExitOnOpposite = Boolean(body.useEarlyExitOnOpposite);
    setIfValidNumber(updateData, "earlyExitOppositeCount", body.earlyExitOppositeCount, { min: 1, max: 10, integer: true });
    // ── 저변동성 TP 하향
    if (body.useLowVolTpReduction !== undefined) updateData.useLowVolTpReduction = Boolean(body.useLowVolTpReduction);
    setIfValidNumber(updateData, "lowVolAtrThreshold", body.lowVolAtrThreshold, { min: 0.1, max: 5.0 });
    setIfValidNumber(updateData, "lowVolTpMultiplier", body.lowVolTpMultiplier, { min: 0.1, max: 1.0 });
    // ── AI 포지션 사이즈
    if (body.useAiPositionSize !== undefined) updateData.useAiPositionSize = Boolean(body.useAiPositionSize);
    setIfValidNumber(updateData, "aiPositionSizeMin", body.aiPositionSizeMin, { min: 0.1, max: 1.0 });
    setIfValidNumber(updateData, "aiPositionSizeMax", body.aiPositionSizeMax, { min: 1.0, max: 3.0 });
    // ── AI 레버리지
    if (body.useAiLeverage !== undefined) updateData.useAiLeverage = Boolean(body.useAiLeverage);
    setIfValidNumber(updateData, "aiLeverageMin", body.aiLeverageMin, { min: 1, max: 125, integer: true });
    setIfValidNumber(updateData, "aiLeverageMax", body.aiLeverageMax, { min: 1, max: 125, integer: true });
    // ── 멀티 AI 합의제
    if (body.useMultiAiConsensus !== undefined) updateData.useMultiAiConsensus = Boolean(body.useMultiAiConsensus);
    // ── AI 동적 TP
    if (body.useAiDynamicTp !== undefined) updateData.useAiDynamicTp = Boolean(body.useAiDynamicTp);
    // ── 심볼 거래 금지
    if (body.useAiSymbolBlock !== undefined) updateData.useAiSymbolBlock = Boolean(body.useAiSymbolBlock);
    // ── 복기 자가 수정
    if (body.useAiAutoTune !== undefined) updateData.useAiAutoTune = Boolean(body.useAiAutoTune);

    // symbolOverrides 객체
    if (body.symbolOverrides !== undefined && body.symbolOverrides && typeof body.symbolOverrides === "object") {
      updateData.symbolOverrides = sanitizeSymbolOverrides(body.symbolOverrides as Record<string, unknown>);
    }

    updateData.updatedAt = new Date();

    let updated;
    if (rows.length === 0) {
      [updated] = await db.insert(botConfigTable).values(updateData).returning();
    } else {
      // ✅ 수정 1: where 절 추가 — 특정 행만 업데이트
      [updated] = await db
        .update(botConfigTable)
        .set(updateData)
        .where(eq(botConfigTable.id, rows[0].id))
        .returning();
    }

    await botManager.reloadConfig();

    res.json(configToResponse(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to update bot config");
    res.status(500).json({ error: "Failed to update bot config" });
  }
});

router.get("/logs", async (req, res) => {
  const limit = parseLimit(req.query.limit, 50, 100);
  try {
    const logs = await db.select().from(botLogsTable).orderBy(desc(botLogsTable.createdAt)).limit(limit);
    res.json({
      logs: logs.map((l) => ({
        id: String(l.id),
        level: l.level,
        message: l.message,
        symbol: l.symbol,
        action: l.action,
        timestamp: l.createdAt.getTime(),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get bot logs");
    res.status(500).json({ error: "Failed to get bot logs" });
  }
});

router.get("/reflections", async (req, res) => {
  const limit = parseLimit(req.query.limit, 20, 100);
  try {
    const rows = await db.select().from(tradeReflectionsTable).orderBy(desc(tradeReflectionsTable.createdAt)).limit(limit);
    res.json({
      reflections: rows.map((r) => ({
        id: String(r.id),
        symbol: r.symbol,
        timeframe: r.timeframe,
        side: r.side,
        entryPrice: r.entryPrice,
        exitPrice: r.exitPrice,
        exitReason: r.exitReason,
        pnl: r.pnl,
        pnlPercent: r.pnlPercent,
        holdSeconds: r.holdSeconds,
        originalConfidence: r.originalConfidence,
        originalExpectedMovePercent: r.originalExpectedMovePercent,
        originalReasoning: r.originalReasoning,
        bullishCount: r.bullishCount,
        bearishCount: r.bearishCount,
        lessonText: r.lessonText,
        timestamp: r.createdAt.getTime(),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get reflections");
    res.status(500).json({ error: "Failed to get reflections" });
  }
});

function sanitizeSymbolOverrides(input: Record<string, unknown>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const numericKeys = ["tradeAmount", "minConfidence", "takeProfitPercent", "stopLossPercent"] as const;
  const ranges: Record<typeof numericKeys[number], { min: number; max: number }> = {
    tradeAmount: { min: 0, max: Number.POSITIVE_INFINITY },
    minConfidence: { min: 0, max: 1 },
    takeProfitPercent: { min: 0, max: 100 },
    stopLossPercent: { min: 0, max: 100 },
  };
  for (const [sym, raw] of Object.entries(input)) {
    if (!isNonEmptyString(sym)) continue;
    if (!raw || typeof raw !== "object") continue;
    const entry: Record<string, number> = {};
    const r = raw as Record<string, unknown>;
    for (const k of numericKeys) {
      const n = toFiniteNumber(r[k]);
      if (n === null) continue;
      const { min, max } = ranges[k];
      if (n < min || n > max) continue;
      entry[k] = n;
    }
    if (Object.keys(entry).length > 0) out[sym] = entry;
  }
  return out;
}

function configToResponse(row: typeof botConfigTable.$inferSelect) {
  const watchSymbols = Array.isArray(row.watchSymbols) && row.watchSymbols.length > 0
    ? (row.watchSymbols as string[])
    : [row.symbol];
  return {
    symbol: row.symbol,
    watchSymbols,
    timeframe: row.timeframe,
    tradeAmount: row.tradeAmount,
    maxPositions: row.maxPositions,
    stopLossPercent: row.stopLossPercent,
    takeProfitPercent: row.takeProfitPercent,
    minConfidence: row.minConfidence,
    enabledIndicators: (row.enabledIndicators as string[]) ?? [],
    autoTrade: row.autoTrade,
    useAiTargets: row.useAiTargets,
    checkIntervalSeconds: row.checkIntervalSeconds,
    maxDailyLossPercent: row.maxDailyLossPercent,
    useMtfFilter: row.useMtfFilter,
    strictMtf: row.strictMtf,
    mtfTimeframes: (row.mtfTimeframes as string[]) ?? ["1h", "4h"],
    useFundingRate: row.useFundingRate,
    symbolOverrides: (row.symbolOverrides as Record<string, Record<string, number>>) ?? {},
    leverage: row.leverage,
    marginType: row.marginType,
    notifyOnError: row.notifyOnError,
    useTrailingStop: row.useTrailingStop,
    trailingActivatePercent: row.trailingActivatePercent,
    trailingDistancePercent: row.trailingDistancePercent,
    usePartialTp: row.usePartialTp,
    partialTpPercent: row.partialTpPercent,
    paperTrading: row.paperTrading,
    entryMode: row.entryMode,
    useEarlyExitOnOpposite: (row as Record<string, unknown>).useEarlyExitOnOpposite as boolean ?? false,
    earlyExitOppositeCount: (row as Record<string, unknown>).earlyExitOppositeCount as number ?? 3,
    useLowVolTpReduction: (row as Record<string, unknown>).useLowVolTpReduction as boolean ?? false,
    lowVolAtrThreshold: (row as Record<string, unknown>).lowVolAtrThreshold as number ?? 0.5,
    lowVolTpMultiplier: (row as Record<string, unknown>).lowVolTpMultiplier as number ?? 0.6,
    useAiPositionSize: (row as Record<string, unknown>).useAiPositionSize as boolean ?? false,
    aiPositionSizeMin: (row as Record<string, unknown>).aiPositionSizeMin as number ?? 0.3,
    aiPositionSizeMax: (row as Record<string, unknown>).aiPositionSizeMax as number ?? 1.5,
    useAiLeverage: (row as Record<string, unknown>).useAiLeverage as boolean ?? false,
    aiLeverageMin: (row as Record<string, unknown>).aiLeverageMin as number ?? 1,
    aiLeverageMax: (row as Record<string, unknown>).aiLeverageMax as number ?? 10,
    useMultiAiConsensus: (row as Record<string, unknown>).useMultiAiConsensus as boolean ?? false,
    useAiDynamicTp: (row as Record<string, unknown>).useAiDynamicTp as boolean ?? false,
    useAiSymbolBlock: (row as Record<string, unknown>).useAiSymbolBlock as boolean ?? false,
    useAiAutoTune: (row as Record<string, unknown>).useAiAutoTune as boolean ?? false,
  };
}

export default router;
