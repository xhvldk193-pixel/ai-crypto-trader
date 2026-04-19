import { db } from "@workspace/db";
import { botConfigTable, botLogsTable, tradeHistoryTable, activePositionsTable, aiSignalsTable, tradeReflectionsTable } from "@workspace/db";
import { eq, gte, sql, desc } from "drizzle-orm";
import { exchangeService } from "./exchange";
import { analyzeDivergences } from "./divergence";
import { computeAtrPercent } from "./indicators";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "./logger";

const ANTHROPIC_MODEL = "claude-opus-4-7";

interface BotStatus {
  running: boolean;
  uptime: number;
  symbol?: string;
  symbols?: string[];
  timeframe?: string;
  lastSignal?: string;
  lastCheckedAt?: number;
  totalSignals: number;
  executedTrades: number;
  dailyPnlUsd: number;
  dailyPnlPercent: number;
  halted: boolean;
}

interface AiDecision {
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  reasoning: string;
  riskLevel: "low" | "medium" | "high";
  expectedMovePercent: number;
  suggestedEntryPrice: number;
  suggestedTakeProfit: number | null;
  suggestedStopLoss: number | null;
}

type BotConfigRow = typeof botConfigTable.$inferSelect;

interface SymbolOverride {
  tradeAmount?: number | null;
  minConfidence?: number | null;
  takeProfitPercent?: number | null;
  stopLossPercent?: number | null;
}

interface EffectiveParams {
  tradeAmount: number;
  minConfidence: number;
  takeProfitPercent: number;
  stopLossPercent: number;
  overridden: string[];
}

function resolveEffectiveParams(config: BotConfigRow, symbol: string): EffectiveParams {
  const overrides = (config.symbolOverrides as Record<string, SymbolOverride> | null) ?? {};
  const o = overrides[symbol] ?? {};
  const overridden: string[] = [];
  const pick = <K extends keyof EffectiveParams>(key: K, base: number): number => {
    const v = o[key as keyof SymbolOverride];
    if (typeof v === "number" && Number.isFinite(v)) {
      overridden.push(key as string);
      return v;
    }
    return base;
  };
  return {
    tradeAmount: pick("tradeAmount", config.tradeAmount),
    minConfidence: pick("minConfidence", config.minConfidence),
    takeProfitPercent: pick("takeProfitPercent", config.takeProfitPercent),
    stopLossPercent: pick("stopLossPercent", config.stopLossPercent),
    overridden,
  };
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return text.trim();
}

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

class BotManager {
  private running = false;
  private startTime: number | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private totalSignals = 0;
  private executedTrades = 0;
  private lastSignal = "HOLD";
  private lastCheckedAt: number | null = null;
  private currentSymbols: string[] = ["BTC/USDT"];
  private currentTimeframe = "15m";
  private tickInFlight = false;
  private halted = false;
  private dailyPnlUsd = 0;
  private dailyPnlPercent = 0;
  private dailyResetDay: number = startOfTodayUtc().getTime();

  getStatus(): BotStatus {
    return {
      running: this.running,
      uptime: this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
      symbol: this.currentSymbols[0],
      symbols: [...this.currentSymbols],
      timeframe: this.currentTimeframe,
      lastSignal: this.lastSignal,
      lastCheckedAt: this.lastCheckedAt ?? undefined,
      totalSignals: this.totalSignals,
      executedTrades: this.executedTrades,
      dailyPnlUsd: this.dailyPnlUsd,
      dailyPnlPercent: this.dailyPnlPercent,
      halted: this.halted,
    };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.startTime = Date.now();

    await this.addLog("info", "트레이딩 봇이 시작되었습니다.");

    const config = await this.getConfig();
    this.currentSymbols = this.resolveWatchSymbols(config);
    this.currentTimeframe = config.timeframe;
    this.intervalId = setInterval(() => this.tick(), config.checkIntervalSeconds * 1000);

    this.tick().catch((err) => logger.error({ err }, "Bot tick error"));
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.startTime = null;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.addLog("info", "트레이딩 봇이 중지되었습니다.").catch(() => {});
  }

  async reloadConfig() {
    if (!this.running) return;
    const config = await this.getConfig();
    this.currentSymbols = this.resolveWatchSymbols(config);
    this.currentTimeframe = config.timeframe;
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = setInterval(() => this.tick(), config.checkIntervalSeconds * 1000);
    await this.addLog("info", `봇 설정이 재로딩되었습니다: [${this.currentSymbols.join(", ")}] ${config.timeframe}`);
  }

  /** Manually clear today's halt (e.g. user override) */
  resetHalt() {
    this.halted = false;
    this.dailyResetDay = startOfTodayUtc().getTime();
    this.addLog("info", "일일 손실 한도 일시 해제 — 거래 재개").catch(() => {});
  }

  private resolveWatchSymbols(config: BotConfigRow): string[] {
    const ws = Array.isArray(config.watchSymbols) ? (config.watchSymbols as string[]) : [];
    const cleaned = ws.filter((s) => typeof s === "string" && s.length > 0);
    if (cleaned.length === 0) return [config.symbol];
    return Array.from(new Set(cleaned));
  }

  private async getConfig(): Promise<BotConfigRow> {
    const rows = await db.select().from(botConfigTable).limit(1);
    if (rows.length === 0) {
      const [created] = await db.insert(botConfigTable).values({}).returning();
      return created;
    }
    return rows[0];
  }

  private async refreshDailyPnl(config: BotConfigRow): Promise<void> {
    const today = startOfTodayUtc().getTime();
    if (today !== this.dailyResetDay) {
      this.dailyResetDay = today;
      this.halted = false;
    }

    try {
      const [{ total }] = await db
        .select({ total: sql<number>`coalesce(sum(${tradeHistoryTable.pnl}), 0)` })
        .from(tradeHistoryTable)
        .where(gte(tradeHistoryTable.createdAt, new Date(today)));
      this.dailyPnlUsd = Number(total) || 0;
    } catch (err) {
      logger.warn({ err }, "Failed to compute daily PnL");
      this.dailyPnlUsd = 0;
    }

    let portfolioBase = config.tradeAmount * 100; // fallback baseline
    try {
      const bal = await exchangeService.getBalance();
      if (bal.totalUsd > 0) portfolioBase = bal.totalUsd;
    } catch {
      // keep fallback
    }
    this.dailyPnlPercent = portfolioBase > 0 ? (this.dailyPnlUsd / portfolioBase) * 100 : 0;

    if (this.dailyPnlPercent <= -config.maxDailyLossPercent && !this.halted) {
      this.halted = true;
      await this.addLog(
        "error",
        `🛑 일일 손실 한도 도달 (${this.dailyPnlPercent.toFixed(2)}%) — 오늘 자동 거래 중단`,
      ).catch(() => {});
    }
  }

  private async tick() {
    if (!this.running) return;
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const config = await this.getConfig();
      const symbols = this.resolveWatchSymbols(config);
      this.currentSymbols = symbols;
      this.currentTimeframe = config.timeframe;
      this.lastCheckedAt = Date.now();

      // Update daily PnL & halt state from realized trades
      await this.refreshDailyPnl(config);

      // Always manage existing positions even if halted (we still want TP/SL exits)
      await this.manageActivePositions();

      if (this.halted) {
        await this.addLog("warning", `🛑 손실 한도 도달 상태 — 신규 진입 건너뜀 (오늘 PnL ${this.dailyPnlPercent.toFixed(2)}%)`);
        return;
      }

      const results = await Promise.allSettled(
        symbols.map((sym) => this.processSymbol(sym, config))
      );
      results.forEach((r, idx) => {
        if (r.status === "rejected") {
          logger.error({ err: r.reason, symbol: symbols[idx] }, "processSymbol failed");
        }
      });
    } catch (err) {
      logger.error({ err }, "Bot tick error");
      await this.addLog("error", `봇 틱 오류: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    } finally {
      this.tickInFlight = false;
    }
  }

  private async getMtfBias(symbol: string, timeframes: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    await Promise.all(timeframes.map(async (tf) => {
      try {
        const candles = await exchangeService.getOhlcv(symbol, tf, 200);
        if (candles.length < 50) { out[tf] = "neutral"; return; }
        const div = analyzeDivergences(candles, symbol, tf);
        out[tf] = div.overallBias;
      } catch (err) {
        logger.warn({ err, symbol, tf }, "MTF analysis failed");
        out[tf] = "neutral";
      }
    }));
    return out;
  }

  private mtfAligned(primaryBias: string, mtf: Record<string, string>): { aligned: boolean; conflicts: string[] } {
    if (primaryBias === "neutral") return { aligned: true, conflicts: [] };
    const conflicts = Object.entries(mtf)
      .filter(([, b]) => b !== "neutral" && b !== primaryBias)
      .map(([tf, b]) => `${tf}=${b}`);
    return { aligned: conflicts.length === 0, conflicts };
  }

  private async processSymbol(symbol: string, config: BotConfigRow) {
    let ticker;
    try {
      ticker = await exchangeService.getTicker(symbol);
    } catch (err) {
      await this.addLog("warning", `${symbol} 티커 조회 실패: ${err instanceof Error ? err.message : String(err)}`, symbol);
      return;
    }

    const candles = await exchangeService.getOhlcv(symbol, config.timeframe, 200);
    if (candles.length < 50) {
      await this.addLog("warning", `${symbol} 캔들 데이터 부족`, symbol);
      return;
    }

    const divergence = analyzeDivergences(candles, symbol, config.timeframe);
    const hasDivergence = divergence.bullishCount > 0 || divergence.bearishCount > 0;

    if (!hasDivergence) {
      await this.addLog("info", `${symbol} @ $${ticker.price.toFixed(2)} — 다이버전스 없음 (관망)`, symbol);
      return;
    }

    // MTF + funding rate (parallel)
    const mtfTfs = config.useMtfFilter ? ((config.mtfTimeframes as string[]) ?? ["1h", "4h"]) : [];
    const [mtf, fundingRate, openInterest] = await Promise.all([
      mtfTfs.length > 0 ? this.getMtfBias(symbol, mtfTfs) : Promise.resolve({} as Record<string, string>),
      config.useFundingRate ? exchangeService.getFundingRate(symbol) : Promise.resolve(null),
      config.useFundingRate ? exchangeService.getOpenInterest(symbol) : Promise.resolve(null),
    ]);

    // Strict MTF gate (skip AI call entirely if higher TFs disagree)
    if (config.useMtfFilter && config.strictMtf) {
      const { aligned, conflicts } = this.mtfAligned(divergence.overallBias, mtf);
      if (!aligned) {
        await this.addLog(
          "info",
          `${symbol} MTF 불일치로 진입 차단 — ${conflicts.join(", ")} (15m=${divergence.overallBias})`,
          symbol,
        );
        return;
      }
    }

    const atrPercent = computeAtrPercent(candles, 14);
    const rawDecision = await this.getAiDecision({
      symbol,
      timeframe: config.timeframe,
      currentPrice: ticker.price,
      change24h: ticker.changePercent24h,
      atrPercent,
      divergence,
      mtf,
      fundingRate,
      openInterest,
    });
    const decision = this.sanitizeDecision(rawDecision, ticker.price, atrPercent);

    this.lastSignal = decision.action;

    await db.insert(aiSignalsTable).values({
      symbol,
      timeframe: config.timeframe,
      action: decision.action,
      confidence: decision.confidence,
      riskLevel: decision.riskLevel,
      currentPrice: ticker.price,
      entryPrice: decision.suggestedEntryPrice,
      takeProfit: decision.suggestedTakeProfit,
      stopLoss: decision.suggestedStopLoss,
      expectedMovePercent: decision.expectedMovePercent,
      expectedMoveUsd: (decision.expectedMovePercent / 100) * decision.suggestedEntryPrice,
      reasoning: decision.reasoning,
      bullishCount: divergence.bullishCount,
      bearishCount: divergence.bearishCount,
    }).catch((err) => logger.error({ err }, "Failed to persist AI signal"));

    if (decision.action === "HOLD") {
      await this.addLog(
        "info",
        `${symbol} @ $${ticker.price.toFixed(2)} — 관망 (강세 ${divergence.bullishCount} / 약세 ${divergence.bearishCount})`,
        symbol
      );
      return;
    }

    this.totalSignals++;
    const tp = decision.suggestedTakeProfit ?? ticker.price;
    const sl = decision.suggestedStopLoss ?? ticker.price;
    const moveTxt = `예상 변동: ${decision.expectedMovePercent >= 0 ? "+" : ""}${decision.expectedMovePercent.toFixed(2)}%`;
    const tpPct = ((tp - decision.suggestedEntryPrice) / decision.suggestedEntryPrice) * 100;
    const slPct = ((sl - decision.suggestedEntryPrice) / decision.suggestedEntryPrice) * 100;
    await this.addLog(
      "trade",
      `신호 ${decision.action} @ $${decision.suggestedEntryPrice.toFixed(2)} — TP $${tp.toFixed(2)} (${tpPct >= 0 ? "+" : ""}${tpPct.toFixed(2)}%) / SL $${sl.toFixed(2)} (${slPct >= 0 ? "+" : ""}${slPct.toFixed(2)}%) — ${moveTxt} | 신뢰도 ${(decision.confidence * 100).toFixed(0)}% — ${decision.reasoning}`,
      symbol,
      decision.action
    );

    const params = resolveEffectiveParams(config, symbol);
    if (params.overridden.length > 0) {
      await this.addLog(
        "info",
        `${symbol} 심볼별 오버라이드 적용: ${params.overridden.join(", ")} (금액 $${params.tradeAmount}, 신뢰도 ${params.minConfidence}, TP ${params.takeProfitPercent}% / SL ${params.stopLossPercent}%)`,
        symbol,
      );
    }

    if (config.autoTrade && decision.confidence >= params.minConfidence) {
      const dir = decision.action === "BUY" ? 1 : -1;
      const side = decision.action === "BUY" ? "long" : "short";

      const entryPrice = ticker.price;
      let takeProfit: number;
      let stopLoss: number;
      if (config.useAiTargets && decision.suggestedTakeProfit !== null && decision.suggestedStopLoss !== null) {
        takeProfit = decision.suggestedTakeProfit;
        stopLoss = decision.suggestedStopLoss;
      } else {
        takeProfit = entryPrice * (1 + dir * params.takeProfitPercent / 100);
        stopLoss = entryPrice * (1 - dir * params.stopLossPercent / 100);
      }

      let positionInserted = false;
      try {
        await db.transaction(async (tx) => {
          const existing = await tx.select().from(activePositionsTable).where(eq(activePositionsTable.symbol, symbol));
          if (existing.length > 0) {
            return;
          }
          const quantity = params.tradeAmount / entryPrice;
          await tx.insert(activePositionsTable).values({
            symbol,
            side,
            entryPrice,
            quantity,
            takeProfit,
            stopLoss,
            expectedMovePercent: decision.expectedMovePercent,
            aiConfidence: decision.confidence,
            aiReasoning: decision.reasoning,
            triggeredBy: "bot",
          });
          positionInserted = true;
        });
      } catch (err) {
        await this.addLog("error", `포지션 등록 실패 (${symbol}): ${err instanceof Error ? err.message : String(err)}`, symbol);
        return;
      }

      if (!positionInserted) {
        await this.addLog("info", `${symbol} 이미 포지션 보유 중 — 신규 진입 건너뜀`, symbol);
        return;
      }

      try {
        const leverage = config.leverage ?? 10;
        const notional = params.tradeAmount * leverage;
        const quantity = notional / entryPrice;
        const positionSide = side === "long" ? "LONG" : "SHORT";
        const order = await exchangeService.placeOrder(
          symbol,
          decision.action.toLowerCase(),
          "market",
          quantity,
          undefined,
          { positionSide, leverage, marginType: config.marginType ?? "ISOLATED" },
        );
        this.executedTrades++;

        await db.insert(tradeHistoryTable).values({
          symbol,
          side: decision.action.toLowerCase(),
          price: entryPrice,
          quantity,
          total: params.tradeAmount,
          fee: params.tradeAmount * 0.001,
          pnl: 0,
          triggeredBy: "bot",
          exchangeOrderId: order.id,
        });

        await this.addLog(
          "trade",
          `진입 ${decision.action} ${symbol} @ $${entryPrice.toFixed(2)} | TP $${takeProfit.toFixed(2)} / SL $${stopLoss.toFixed(2)}`,
          symbol,
          decision.action
        );
      } catch (err) {
        await db.delete(activePositionsTable).where(eq(activePositionsTable.symbol, symbol)).catch(() => {});
        await this.addLog("error", `거래 실행 실패 (${symbol}): ${err instanceof Error ? err.message : String(err)}`, symbol);
      }
    }
  }

  /** Sanitize the AI decision in code (don't trust prompt-only safety) */
  private sanitizeDecision(
    decision: AiDecision,
    currentPrice: number,
    atrPercent: number | null
  ): AiDecision {
    if (decision.action === "HOLD") {
      return { ...decision, expectedMovePercent: 0, suggestedTakeProfit: null, suggestedStopLoss: null };
    }
    const dir = decision.action === "BUY" ? 1 : -1;

    let movePct = decision.expectedMovePercent;
    if (!Number.isFinite(movePct)) movePct = 0;
    if (dir === 1 && movePct < 0) movePct = Math.abs(movePct);
    if (dir === -1 && movePct > 0) movePct = -Math.abs(movePct);
    const absMove = Math.min(6, Math.max(0.2, Math.abs(movePct)));
    movePct = dir * absMove;

    let entry = decision.suggestedEntryPrice;
    if (!Number.isFinite(entry) || entry <= 0) entry = currentPrice;
    const maxDeviation = currentPrice * 0.005;
    if (Math.abs(entry - currentPrice) > maxDeviation) entry = currentPrice;

    const expectedMoveAbs = absMove / 100;
    let tp = decision.suggestedTakeProfit;
    let sl = decision.suggestedStopLoss;

    const tpDistanceOk = tp !== null && Number.isFinite(tp) && (dir === 1 ? tp > entry : tp < entry);
    const slDistanceOk = sl !== null && Number.isFinite(sl) && (dir === 1 ? sl < entry : sl > entry);

    if (!tpDistanceOk) {
      tp = entry * (1 + dir * expectedMoveAbs);
    }
    if (!slDistanceOk) {
      const slMoveAbs = Math.max(0.001, expectedMoveAbs * 0.5);
      sl = entry * (1 - dir * slMoveAbs);
    }

    const minStopPct = Math.max(0.0015, (atrPercent ?? 0.3) / 100 * 0.5);
    const slDistance = Math.abs((sl as number) - entry) / entry;
    if (slDistance < minStopPct) {
      sl = entry * (1 - dir * minStopPct);
    }
    const tpDistance = Math.abs((tp as number) - entry) / entry;
    const slDistance2 = Math.abs((sl as number) - entry) / entry;
    if (tpDistance < slDistance2 * 1.2) {
      tp = entry * (1 + dir * Math.max(slDistance2 * 1.2, expectedMoveAbs));
    }

    return {
      ...decision,
      expectedMovePercent: movePct,
      suggestedEntryPrice: entry,
      suggestedTakeProfit: tp,
      suggestedStopLoss: sl,
    };
  }

  /** Check active positions and close ones that hit TP or SL */
  private async manageActivePositions() {
    const positions = await db.select().from(activePositionsTable);
    if (positions.length === 0) return;

    await Promise.allSettled(positions.map(async (pos) => {
      let price: number;
      try {
        price = (await exchangeService.getTicker(pos.symbol)).price;
      } catch (err) {
        logger.warn({ err, symbol: pos.symbol }, "Failed to fetch ticker for position");
        return;
      }

      const isLong = pos.side === "long";
      const tpHit = isLong ? price >= pos.takeProfit : price <= pos.takeProfit;
      const slHit = isLong ? price <= pos.stopLoss : price >= pos.stopLoss;

      if (!tpHit && !slHit) return;

      const exitReason = tpHit ? "TP" : "SL";
      try {
        const positionSide = isLong ? "LONG" : "SHORT";
        // Always trust the exchange for actual quantity to avoid -2022 ReduceOnly rejections
        let actualQty = pos.quantity;
        try {
          const onExchange = await exchangeService.getPositionAmount(pos.symbol, positionSide);
          if (onExchange <= 0) {
            // Position no longer exists on Binance (manually closed, liquidated, or never opened).
            // Just clean up DB and skip the close order.
            await db.delete(activePositionsTable).where(eq(activePositionsTable.id, pos.id));
            await this.addLog(
              "warning",
              `${pos.symbol} ${positionSide} 거래소에 실제 포지션이 없어 DB만 정리`,
              pos.symbol,
            );
            return;
          }
          actualQty = onExchange;
        } catch (err) {
          logger.warn({ err, symbol: pos.symbol }, "Failed to fetch on-exchange position; falling back to DB qty");
        }

        await exchangeService.placeOrder(
          pos.symbol,
          isLong ? "sell" : "buy",
          "market",
          actualQty,
          undefined,
          { positionSide, reduceOnly: true },
        );
        const pnl = (price - pos.entryPrice) * pos.quantity * (isLong ? 1 : -1);
        const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100 * (isLong ? 1 : -1);
        const holdSeconds = Math.max(0, Math.floor((Date.now() - pos.openedAt.getTime()) / 1000));

        await db.insert(tradeHistoryTable).values({
          symbol: pos.symbol,
          side: isLong ? "sell" : "buy",
          price,
          quantity: pos.quantity,
          total: price * pos.quantity,
          fee: price * pos.quantity * 0.001,
          pnl,
          triggeredBy: "bot",
        });

        // Look up the most recent AI signal for this symbol to enrich the reflection
        let bullishCount = 0, bearishCount = 0, originalConfidence: number | null = pos.aiConfidence;
        let originalReasoning: string | null = pos.aiReasoning;
        let originalExpectedMovePercent: number | null = pos.expectedMovePercent;
        let timeframe: string | null = null;
        try {
          const recent = await db.select().from(aiSignalsTable)
            .where(eq(aiSignalsTable.symbol, pos.symbol))
            .orderBy(desc(aiSignalsTable.createdAt))
            .limit(1);
          if (recent.length > 0) {
            bullishCount = recent[0].bullishCount;
            bearishCount = recent[0].bearishCount;
            timeframe = recent[0].timeframe;
            if (originalConfidence == null) originalConfidence = recent[0].confidence;
            if (!originalReasoning) originalReasoning = recent[0].reasoning;
            if (originalExpectedMovePercent == null) originalExpectedMovePercent = recent[0].expectedMovePercent;
          }
        } catch {
          // best-effort
        }

        const [reflectionRow] = await db.insert(tradeReflectionsTable).values({
          symbol: pos.symbol,
          timeframe,
          side: pos.side,
          entryPrice: pos.entryPrice,
          exitPrice: price,
          exitReason,
          pnl,
          pnlPercent: pnlPct,
          holdSeconds,
          originalConfidence,
          originalExpectedMovePercent,
          originalReasoning,
          bullishCount,
          bearishCount,
        }).returning();

        await db.delete(activePositionsTable).where(eq(activePositionsTable.id, pos.id));

        await this.addLog(
          exitReason === "TP" ? "trade" : "warning",
          `${exitReason} 청산: ${pos.symbol} @ $${price.toFixed(2)} | 진입 $${pos.entryPrice.toFixed(2)} | P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`,
          pos.symbol,
          isLong ? "SELL" : "BUY"
        );

        // Generate AI lesson asynchronously — never block the position close
        if (reflectionRow) {
          this.writeReflectionLesson(reflectionRow.id, {
            symbol: pos.symbol,
            timeframe: timeframe ?? "15m",
            side: pos.side,
            entryPrice: pos.entryPrice,
            exitPrice: price,
            exitReason,
            pnlPercent: pnlPct,
            holdSeconds,
            originalConfidence: originalConfidence ?? null,
            originalExpectedMovePercent: originalExpectedMovePercent ?? null,
            originalReasoning: originalReasoning ?? null,
            bullishCount,
            bearishCount,
          }).catch((err) => logger.warn({ err, id: reflectionRow.id }, "Reflection lesson generation failed"));
        }
      } catch (err) {
        await this.addLog("error", `포지션 청산 실패 (${pos.symbol}): ${err instanceof Error ? err.message : String(err)}`, pos.symbol);
      }
    }));
  }

  /** Async: ask Claude to write a 2-3 sentence Korean post-mortem note */
  private async writeReflectionLesson(reflectionId: number, ctx: {
    symbol: string;
    timeframe: string;
    side: string;
    entryPrice: number;
    exitPrice: number;
    exitReason: string;
    pnlPercent: number;
    holdSeconds: number;
    originalConfidence: number | null;
    originalExpectedMovePercent: number | null;
    originalReasoning: string | null;
    bullishCount: number;
    bearishCount: number;
  }) {
    const verdict = ctx.exitReason === "TP" ? "성공" : "실패";
    const userMessage = `다음은 방금 종료된 자동 매매의 결과입니다. 2-3문장의 한국어 복기 노트를 작성하세요.
다음에 비슷한 상황에서 AI가 참고할 수 있게 핵심 교훈만 짧고 구체적으로 적으세요.
"이런 조건일 때 진입을 보류한다", "이런 조합은 신뢰도를 더 높여서 본다" 같은 실용적 지침 위주로 작성하세요.

거래 정보:
- 심볼: ${ctx.symbol}, 타임프레임: ${ctx.timeframe}, 방향: ${ctx.side.toUpperCase()}
- 결과: ${verdict} (${ctx.exitReason}) — 손익 ${ctx.pnlPercent >= 0 ? "+" : ""}${ctx.pnlPercent.toFixed(2)}%
- 진입가 $${ctx.entryPrice.toFixed(4)} → 청산가 $${ctx.exitPrice.toFixed(4)}, 보유 ${Math.floor(ctx.holdSeconds / 60)}분
- 진입 시 강세 다이버전스 ${ctx.bullishCount}개 / 약세 ${ctx.bearishCount}개
- 당시 AI 신뢰도: ${ctx.originalConfidence !== null ? (ctx.originalConfidence * 100).toFixed(0) + "%" : "미상"}
- 당시 예측 변동: ${ctx.originalExpectedMovePercent !== null ? (ctx.originalExpectedMovePercent >= 0 ? "+" : "") + ctx.originalExpectedMovePercent.toFixed(2) + "%" : "미상"}
- 당시 진입 근거: ${ctx.originalReasoning ?? "기록 없음"}

JSON 없이, 순수 한국어 텍스트만 출력하세요.`;

    try {
      const message = await anthropic.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 512,
        system: "당신은 트레이딩 봇의 복기를 돕는 분석가입니다. 결과의 원인과 다음에 적용할 구체적 규칙을 짧고 명확하게 작성합니다.",
        messages: [{ role: "user", content: userMessage }],
      });
      const block = message.content[0];
      const text = block && block.type === "text" ? block.text.trim() : "";
      if (!text) return;
      await db.update(tradeReflectionsTable).set({ lessonText: text }).where(eq(tradeReflectionsTable.id, reflectionId));
    } catch (err) {
      logger.warn({ err, reflectionId }, "Failed to generate reflection lesson");
    }
  }

  /** Fetch recent reflections for a symbol (and a few global) for AI context */
  private async fetchRecentReflections(symbol: string): Promise<string> {
    try {
      const symbolRows = await db.select().from(tradeReflectionsTable)
        .where(eq(tradeReflectionsTable.symbol, symbol))
        .orderBy(desc(tradeReflectionsTable.createdAt))
        .limit(8);
      let rows = symbolRows;
      if (rows.length < 4) {
        const globalRows = await db.select().from(tradeReflectionsTable)
          .orderBy(desc(tradeReflectionsTable.createdAt))
          .limit(8);
        const seen = new Set(rows.map((r) => r.id));
        for (const g of globalRows) {
          if (rows.length >= 8) break;
          if (!seen.has(g.id)) rows.push(g);
        }
      }
      if (rows.length === 0) return "  (아직 복기 데이터 없음)";
      return rows.map((r) => {
        const verdict = r.exitReason === "TP" ? "✓익절" : r.exitReason === "SL" ? "✗손절" : r.exitReason;
        const pnlPart = `${r.pnlPercent >= 0 ? "+" : ""}${r.pnlPercent.toFixed(2)}%`;
        const lesson = r.lessonText ? r.lessonText.replace(/\s+/g, " ").trim() : "(복기 노트 생성 중)";
        return `  - [${verdict} ${pnlPart}] ${r.symbol} ${r.side.toUpperCase()} 강세${r.bullishCount}/약세${r.bearishCount}: ${lesson}`;
      }).join("\n");
    } catch (err) {
      logger.warn({ err }, "Failed to fetch reflections");
      return "  (복기 데이터 조회 실패)";
    }
  }

  private async getAiDecision(input: {
    symbol: string;
    timeframe: string;
    currentPrice: number;
    change24h: number;
    atrPercent: number | null;
    divergence: ReturnType<typeof analyzeDivergences>;
    mtf: Record<string, string>;
    fundingRate: number | null;
    openInterest: number | null;
  }): Promise<AiDecision> {
    const { symbol, timeframe, currentPrice, change24h, atrPercent, divergence, mtf, fundingRate, openInterest } = input;

    const systemPrompt = `You are an expert crypto trading bot specialized in divergence-based scalping on the ${timeframe} timeframe.
Use multi-indicator divergence signals (MACD, RSI, Stoch, CCI, MOM, OBV), multi-timeframe (MTF) bias, funding rate sentiment, and recent ATR volatility to predict the next ~10–20 candle price move.

Rules:
- expectedMovePercent must be SIGNED: positive for bullish (BUY), negative for bearish (SELL), 0 for HOLD.
- Typical 15m moves: 0.3%–2.5%; strong multi-indicator setups can reach 3–5%.
- suggestedTakeProfit = entryPrice × (1 + expectedMovePercent/100).
- suggestedStopLoss is on the opposite side, sized 0.4–0.7× of |expectedMovePercent| to keep R/R ≥ 1.3.
- suggestedEntryPrice can equal the current price.
- If higher MTFs strongly disagree with the primary bias, prefer HOLD or reduce confidence.
- Funding rate: very positive = crowded longs (mild bearish bias); very negative = crowded shorts (mild bullish bias).
- Set HOLD if signals are weak/conflicting.

Reasoning must be in Korean (2–3 sentences) and explain (1) the dominant divergence direction & strength, (2) MTF + funding context, (3) the predicted move and chosen TP/SL.

Respond ONLY with valid JSON (no markdown, no prose):
{
  "action": "BUY"|"SELL"|"HOLD",
  "confidence": 0.0-1.0,
  "reasoning": "Korean 2-3 sentences",
  "riskLevel": "low"|"medium"|"high",
  "expectedMovePercent": signed number,
  "suggestedEntryPrice": number,
  "suggestedTakeProfit": number,
  "suggestedStopLoss": number
}`;

    const sigList = divergence.signals.map(s => `${s.indicator}/${s.type}@${s.strength.toFixed(2)}`).join(", ") || "none";
    const mtfText = Object.keys(mtf).length > 0
      ? Object.entries(mtf).map(([tf, b]) => `  - ${tf}: ${b}`).join("\n")
      : "  (disabled)";
    const frText = fundingRate !== null
      ? `Funding rate: ${(fundingRate * 100).toFixed(4)}%`
      : "Funding rate: unavailable";
    const oiText = openInterest !== null
      ? `Open interest: ${openInterest.toLocaleString()} contracts`
      : "Open interest: unavailable";

    const reflections = await this.fetchRecentReflections(symbol);

    const userMessage = `Symbol: ${symbol}
Timeframe: ${timeframe}
Current Price: $${currentPrice.toFixed(2)}
24h Change: ${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%
ATR (volatility): ${atrPercent !== null ? `${atrPercent.toFixed(2)}% of price` : "unknown"}

Divergence Bias (primary TF): ${divergence.overallBias}
Bullish signals: ${divergence.bullishCount}
Bearish signals: ${divergence.bearishCount}
Active: ${sigList}

Multi-Timeframe Bias:
${mtfText}

Futures context:
${frText}
${oiText}

최근 거래 복기 (지난 결과로부터 학습할 것 — 비슷한 조건이면 패턴을 따르고, 반복된 손절 조합은 회피하세요):
${reflections}

Predict the next ~10–20 candle price move and decide BUY/SELL/HOLD with TP/SL. 위 복기 노트의 교훈을 반드시 reasoning에 1번 이상 반영하세요.`;

    const message = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const block = message.content[0];
    const content = block && block.type === "text" ? block.text : "";
    if (!content) throw new Error("Empty AI response");

    const parsed = JSON.parse(extractJson(content));
    const action = (parsed.action as string) === "BUY" || parsed.action === "SELL" ? parsed.action : "HOLD";
    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5));
    const entryPrice = Number(parsed.suggestedEntryPrice) || currentPrice;
    let expectedMovePercent = Number.isFinite(parsed.expectedMovePercent) ? Number(parsed.expectedMovePercent) : 0;
    if (action === "HOLD") expectedMovePercent = 0;

    let takeProfit: number | null = Number(parsed.suggestedTakeProfit);
    let stopLoss: number | null = Number(parsed.suggestedStopLoss);

    if (action === "HOLD") {
      takeProfit = null; stopLoss = null;
    } else if (!Number.isFinite(takeProfit) || !Number.isFinite(stopLoss)) {
      const moveAbs = Math.abs(expectedMovePercent) / 100 || (atrPercent ?? 1) / 100;
      const dir = action === "BUY" ? 1 : -1;
      takeProfit = entryPrice * (1 + dir * moveAbs);
      stopLoss = entryPrice * (1 - dir * moveAbs * 0.5);
    }

    return {
      action,
      confidence,
      reasoning: parsed.reasoning || "분석 결과가 제공되지 않았습니다.",
      riskLevel: (parsed.riskLevel as "low" | "medium" | "high") || "medium",
      expectedMovePercent,
      suggestedEntryPrice: entryPrice,
      suggestedTakeProfit: takeProfit,
      suggestedStopLoss: stopLoss,
    };
  }

  private async addLog(level: string, message: string, symbol?: string, action?: string) {
    try {
      await db.insert(botLogsTable).values({ level, message, symbol, action });
    } catch (err) {
      logger.error({ err }, "Failed to insert bot log");
    }
  }
}

export const botManager = new BotManager();
