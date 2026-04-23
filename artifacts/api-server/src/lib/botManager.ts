import { db } from "@workspace/db";
import { botConfigTable, botLogsTable, tradeHistoryTable, activePositionsTable, aiSignalsTable, tradeReflectionsTable } from "@workspace/db";
import { eq, gte, sql, desc, and } from "drizzle-orm";
import { exchangeService } from "./exchange";
import { analyzeDivergences } from "./divergence";
import { computeAtrPercent } from "./indicators";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "./logger";
import { notifyAlert, notifyEntry, notifyExit } from "./telegram";

const ANTHROPIC_MODEL = "claude-haiku-4-5";

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

  private positionIntervalId: ReturnType<typeof setInterval> | null = null;
  private positionCheckInFlight = false;
  private readonly POSITION_CHECK_INTERVAL_MS = 30 * 1000;

  private totalSignals = 0;
  private executedTrades = 0;
  private lastSignal = "HOLD";
  private lastCheckedAt: number | null = null;
  private currentSymbols: string[] = ["BTC/USDT"];
  private currentTimeframe = "15m";
  private tickInFlight = false;
  private tickCount = 0;
  private halted = false;
  private dailyPnlUsd = 0;
  private dailyPnlPercent = 0;
  private dailyResetDay: number = startOfTodayUtc().getTime();

  private cachedConfig: BotConfigRow | null = null;

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

    try {
      await this.syncWithExchange("auto");
    } catch (err) {
      logger.warn({ err }, "Initial sync failed");
    }

    const config = await this.getConfig();
    this.currentSymbols = this.resolveWatchSymbols(config);
    this.currentTimeframe = config.timeframe;

    this.intervalId = setInterval(() => this.tick(), config.checkIntervalSeconds * 1000);
    this.positionIntervalId = setInterval(() => this.positionTick(), this.POSITION_CHECK_INTERVAL_MS);

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
    if (this.positionIntervalId) {
      clearInterval(this.positionIntervalId);
      this.positionIntervalId = null;
    }
    this.addLog("info", "트레이딩 봇이 중지되었습니다.").catch(() => {});
  }

  async reloadConfig() {
    this.cachedConfig = null;
    const config = await this.getConfig();
    this.currentSymbols = this.resolveWatchSymbols(config);
    this.currentTimeframe = config.timeframe;
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = setInterval(() => this.tick(), config.checkIntervalSeconds * 1000);

    if (this.positionIntervalId) clearInterval(this.positionIntervalId);
    this.positionIntervalId = setInterval(() => this.positionTick(), this.POSITION_CHECK_INTERVAL_MS);

    await this.addLog("info", `봇 설정이 재로딩되었습니다.: [${this.currentSymbols.join(", ")}] ${config.timeframe}`);
  }

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
      this.cachedConfig = created;
      return created;
    }
    this.cachedConfig = rows[0];
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

    let portfolioBase = config.tradeAmount * 100;
    try {
      const bal = await exchangeService.getBalance();
      if (bal.totalUsd > 0) portfolioBase = bal.totalUsd;
    } catch {
      // keep fallback
    }
    this.dailyPnlPercent = portfolioBase > 0 ? (this.dailyPnlUsd / portfolioBase) * 100 : 0;

    const maxLoss = config.maxDailyLossPercent > 0 ? config.maxDailyLossPercent : 5;
    if (this.dailyPnlPercent <= -maxLoss && !this.halted) {
      this.halted = true;
      const msg = `🛑 일일 손실 한도 도달 (${this.dailyPnlPercent.toFixed(2)}%) — 오늘 자동 거래 중단` ;
      await this.addLog("error", msg).catch(() => {});
      await this.maybeNotify("error", msg, config, "daily-loss-halt");
    }
  }

  private async positionTick() {
    if (!this.running) return;
    if (this.positionCheckInFlight) return;
    if (this.tickInFlight) return;

    this.positionCheckInFlight = true;
    try {
      const config = await this.getConfig();
      await this.manageActivePositions(config);
    } catch (err) {
      logger.error({ err }, "Position tick error");
    } finally {
      this.positionCheckInFlight = false;
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

      this.tickCount += 1;
      try { await this.syncWithExchange("auto"); }
      catch (err) { logger.warn({ err }, "Auto-sync failed"); }

      await this.refreshDailyPnl(config);

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
      const msg = err instanceof Error ? err.message : String(err);
      await this.addLog("error", `봇 틱 오류: ${msg}`).catch(() => {});
      const cfg = this.cachedConfig ?? await this.getConfig().catch(() => null);
      if (cfg) await this.maybeNotify("error", `봇 틱 오류: ${msg}`, cfg, "tick-error");
    } finally {
      this.tickInFlight = false;
    }
  }

  private async maybeNotify(level: "error" | "warning" | "info", message: string, config: BotConfigRow, key?: string) {
    try {
      if (config.notifyOnError) await notifyAlert(level, message, key);
    } catch { /* best-effort */ }
  }

  async syncWithExchange(mode: "auto" | "adopt" = "adopt"): Promise<{ added: number; removed: number; details: string[] }> {
    const details: string[] = [];
    let added = 0, removed = 0;
    let exchangePositions;
    try {
      exchangePositions = await exchangeService.getPositions();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`거래소 포지션 조회 실패: ${msg}`);
    }
    const dbPositions = await db.select().from(activePositionsTable);

    const normalize = (s: string): string => {
      if (s.includes("/")) return s;
      if (s.endsWith("USDT")) return `${s.slice(0, -4)}/USDT`;
      return s;
    };
    const exMap = new Map<string, typeof exchangePositions[number]>();
    for (const ex of exchangePositions) exMap.set(`${normalize(ex.symbol)}|${ex.side}`, ex);

    for (const dbPos of dbPositions) {
      if (dbPos.triggeredBy === "paper") continue;
      const k = `${dbPos.symbol}|${dbPos.side}`;
      if (!exMap.has(k)) {
        await db.delete(activePositionsTable).where(eq(activePositionsTable.id, dbPos.id));
        removed++;
        details.push(`DB→정리: ${dbPos.symbol} ${dbPos.side}`);
      }
    }

    const dbKeys = new Set(
      dbPositions.filter((p) => p.triggeredBy !== "paper").map((p) => `${p.symbol}|${p.side}`)
    );
    for (const ex of exchangePositions) {
      const sym = normalize(ex.symbol);
      const k = `${sym}|${ex.side}`;
      if (dbKeys.has(k)) continue;

      if (mode === "auto") {
        details.push(`거래소 단독 포지션 감지(미추적): ${sym} ${ex.side} qty=${ex.quantity}`);
        await this.addLog(
          "info",
          `거래소에 봇이 추적하지 않는 포지션 발견: ${sym} ${ex.side} qty=${ex.quantity} (수동 동기화 버튼으로 인계 가능)`,
          sym,
        );
        continue;
      }

      const dir = ex.side === "long" ? 1 : -1;
      let tp = ex.entryPrice * (1 + dir * 0.02);
      let sl = ex.entryPrice * (1 - dir * 0.01);
      try {
        const openOrders = await exchangeService.getOpenOrders(sym);
        const closingSide = ex.side === "long" ? "sell" : "buy";
        for (const o of openOrders) {
          if (o.side?.toLowerCase() !== closingSide) continue;
          const ot = (o.type || "").toLowerCase();
          if (ot.includes("take_profit") && o.price > 0) tp = o.price;
          else if (ot.includes("stop") && o.price > 0) sl = o.price;
        }
      } catch { /* fall back to placeholders */ }

      try {
        await db.insert(activePositionsTable).values({
          symbol: sym,
          side: ex.side,
          entryPrice: ex.entryPrice,
          quantity: ex.quantity,
          takeProfit: tp,
          stopLoss: sl,
          triggeredBy: "sync",
        });
        added++;
        details.push(`DB←추가: ${sym} ${ex.side} qty=${ex.quantity} entry=$${ex.entryPrice.toFixed(2)} TP=$${tp.toFixed(2)} SL=$${sl.toFixed(2)}`);
      } catch (err) {
        details.push(`추가 실패 ${sym}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (removed > 0) {
      await this.addLog("warning", `거래소↔DB 동기화: DB 정리 -${removed} (거래소에 없는 phantom 포지션 제거)`).catch(() => {});
    }
    if (added > 0) {
      await this.addLog("info", `거래소↔DB 동기화: 거래소→DB +${added}`).catch(() => {});
    }
    return { added, removed, details };
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
      await this.addLog("info", `${symbol} @ $${ticker.price.toFixed(2)} — 다이버전스 없음 (관망, AI 호출 스킵)`, symbol);
      return;
    }

    const strongEnough = divergence.bullishCount >= 2 || divergence.bearishCount >= 2;
    if (!strongEnough) {
      await this.addLog(
        "info",
        `${symbol} @ $${ticker.price.toFixed(2)} — 신호 약함 (강세 ${divergence.bullishCount} / 약세 ${divergence.bearishCount}, AI 호출 스킵)`,
        symbol,
      );
      return;
    }

    const mtfTfs = config.useMtfFilter ? ((config.mtfTimeframes as string[]) ?? ["1h", "4h"]) : [];
    const [mtf, fundingRate, openInterest] = await Promise.all([
      mtfTfs.length > 0 ? this.getMtfBias(symbol, mtfTfs) : Promise.resolve({} as Record<string, string>),
      config.useFundingRate ? exchangeService.getFundingRate(symbol) : Promise.resolve(null),
      config.useFundingRate ? exchangeService.getOpenInterest(symbol) : Promise.resolve(null),
    ]);

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

    if (decision.action === "HOLD") {
      await this.addLog(
        "info",
        `${symbol} @ $${ticker.price.toFixed(2)} — AI 관망 (강세 ${divergence.bullishCount} / 약세 ${divergence.bearishCount}) | ${decision.reasoning}`,
        symbol
      );
      return;
    }

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

    let params = resolveEffectiveParams(config, symbol);
    if (params.overridden.length > 0) {
      await this.addLog(
        "info",
        `${symbol} 심볼별 오버라이드 적용: ${params.overridden.join(", ")} (금액 $${params.tradeAmount}, 신뢰도 ${params.minConfidence}, TP ${params.takeProfitPercent}% / SL ${params.stopLossPercent}%)`,
        symbol,
      );
    }

    if (!config.autoTrade) {
      await this.addLog(
        "info",
        `${symbol} 진입 스킵 — 자동매매 OFF (신호: ${decision.action}, 신뢰도 ${(decision.confidence * 100).toFixed(0)}%)`,
        symbol,
      );
      return;
    }
    if (decision.confidence < params.minConfidence) {
      await this.addLog(
        "info",
        `${symbol} 진입 스킵 — 신뢰도 부족 (${(decision.confidence * 100).toFixed(0)}% < 최소 ${(params.minConfidence * 100).toFixed(0)}%)`,
        symbol,
      );
      return;
    }
    if (this.halted) {
      await this.addLog(
        "warning",
        `${symbol} 진입 스킵 — 일일 손실 한도 도달 상태`,
        symbol,
      );
      return;
    }

    {
      const dir = decision.action === "BUY" ? 1 : -1;
      const side = decision.action === "BUY" ? "long" : "short";

      // ✅ 수정1: True → true, paperTrade → paperTrading
      const isPaper = config.paperTrading ?? true;

      if (!isPaper && (config.entryMode ?? "fixed") === "full") {
        try {
          const bal = await exchangeService.getBalance();
          const usdt = bal.balances.find((b) => b.asset === "USDT");
          const free = usdt?.free ?? 0;
          const allIn = Math.floor(free * 0.99 * 100) / 100;
          if (allIn <= 0) {
            await this.addLog(
              "warning",
              `${symbol} 진입 스킵 — 가용 USDT 잔고 없음 ($${free.toFixed(2)})`,
              symbol,
            );
            return;
          }
          await this.addLog(
            "info",
            `${symbol} 풀 진입 모드 — 가용 잔고 $${free.toFixed(2)} × 99% = 증거금 $${allIn} 사용`,
            symbol,
          );
          params = { ...params, tradeAmount: allIn };
        } catch (err) {
          await this.addLog(
            "error",
            `${symbol} 진입 스킵 — 잔고 조회 실패: ${err instanceof Error ? err.message : String(err)}`,
            symbol,
          );
          return;
        }
      }

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
          const existing = await tx.select().from(activePositionsTable).where(and(eq(activePositionsTable.symbol, symbol), eq(activePositionsTable.side, side)));
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
            triggeredBy: isPaper ? "paper" : "bot",
          });
          positionInserted = true;
        });
      } catch (err) {
        const errMsg = `포지션 등록 실패 (${symbol}): ${err instanceof Error ? err.message : String(err)}`;
        await this.addLog("error", errMsg, symbol);
        await this.maybeNotify("error", `❌ ${errMsg}`, config, `pos-register-fail-${symbol}`);
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

        let exchangeOrderId: string | undefined;
        if (isPaper) {
          await db.update(activePositionsTable)
            .set({ quantity })
            .where(eq(activePositionsTable.symbol, symbol));
        } else {
          const order = await exchangeService.placeOrder(
            symbol,
            decision.action.toLowerCase(),
            "market",
            quantity,
            undefined,
            { positionSide, leverage, marginType: config.marginType ?? "ISOLATED" },
          );
          exchangeOrderId = order.id;
          await db.update(activePositionsTable)
            .set({ quantity })
            .where(eq(activePositionsTable.symbol, symbol));
        }
        this.executedTrades++;

        await db.insert(tradeHistoryTable).values({
          symbol,
          side: decision.action.toLowerCase(),
          price: entryPrice,
          quantity,
          total: params.tradeAmount,
          fee: params.tradeAmount * 0.001,
          pnl: 0,
          triggeredBy: isPaper ? "paper" : "bot",
          exchangeOrderId,
        });

        await this.addLog(
          "trade",
          `${isPaper ? "[가상] " : ""}진입 ${decision.action} ${symbol} @ $${entryPrice.toFixed(2)} | TP $${takeProfit.toFixed(2)} / SL $${stopLoss.toFixed(2)}`,
          symbol,
          decision.action
        );

        this.fetchSignalStats(symbol).then((signalStats) => {
          notifyEntry({
            symbol,
            action: decision.action,
            entryPrice,
            takeProfit,
            stopLoss,
            confidence: decision.confidence,
            expectedMovePercent: decision.expectedMovePercent,
            bullishCount: divergence.bullishCount,
            bearishCount: divergence.bearishCount,
            signalStats,
            isPaper,
          });
        }).catch((err) => logger.warn({ err }, "Failed to send entry notification"));
      } catch (err) {
        await db.delete(activePositionsTable).where(eq(activePositionsTable.symbol, symbol)).catch(() => {});
        const msg = err instanceof Error ? err.message : String(err);
        await this.addLog("error", `거래 실행 실패 (${symbol}): ${msg}`, symbol);
        await this.maybeNotify("error", `진입 주문 실패 (${symbol}): ${msg}`, config, `entry-fail-${symbol}`);

        try {
          let bullishCount = 0, bearishCount = 0;
          try {
            const recent = await db.select().from(aiSignalsTable)
              .where(eq(aiSignalsTable.symbol, symbol))
              .orderBy(desc(aiSignalsTable.createdAt))
              .limit(1);
            if (recent.length > 0) {
              bullishCount = recent[0].bullishCount;
              bearishCount = recent[0].bearishCount;
            }
          } catch {
            // best-effort
          }

          const [reflectionRow] = await db.insert(tradeReflectionsTable).values({
            symbol,
            timeframe: config.timeframe,
            side,
            entryPrice,
            exitPrice: entryPrice,
            exitReason: "ENTRY_FAILED",
            pnl: 0,
            pnlPercent: 0,
            holdSeconds: 0,
            originalConfidence: decision.confidence,
            originalExpectedMovePercent: decision.expectedMovePercent,
            originalReasoning: decision.reasoning,
            bullishCount,
            bearishCount,
            lessonText: `진입 실패 사유: ${msg}`,
          }).returning();

          if (reflectionRow) {
            // ✅ 수정2: leverage 추가 (진입 실패 시)
            this.writeReflectionLesson(reflectionRow.id, {
              symbol,
              timeframe: config.timeframe,
              side,
              entryPrice,
              exitPrice: entryPrice,
              exitReason: "ENTRY_FAILED",
              pnlPercent: 0,
              holdSeconds: 0,
              originalConfidence: decision.confidence,
              originalExpectedMovePercent: decision.expectedMovePercent,
              originalReasoning: decision.reasoning,
              bullishCount,
              bearishCount,
              leverage: config.leverage ?? 10,
              failureMessage: msg,
            }).catch((e) => logger.warn({ err: e, id: reflectionRow.id }, "Failed-entry reflection lesson generation failed"));
          }
        } catch (refErr) {
          logger.warn({ err: refErr, symbol }, "Failed to record failed-entry reflection");
        }
      }
    }
  }

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

  private async manageActivePositions(config?: BotConfigRow) {
    const positions = await db.select().from(activePositionsTable);
    if (positions.length === 0) return;

    const cfg = config ?? await this.getConfig();

    await Promise.allSettled(positions.map(async (pos) => {
      let price: number;
      try {
        price = (await exchangeService.getTicker(pos.symbol)).price;
      } catch (err) {
        logger.warn({ err, symbol: pos.symbol }, "Failed to fetch ticker for position");
        return;
      }

      const isLong = pos.side === "long";

      if (cfg.useTrailingStop) {
        const moveFromEntryPct = ((price - pos.entryPrice) / pos.entryPrice) * 100 * (isLong ? 1 : -1);
        const activate = cfg.trailingActivatePercent ?? 1.0;
        const distance = cfg.trailingDistancePercent ?? 0.5;
        if (moveFromEntryPct >= activate) {
          const hwm = pos.highWaterMark ?? pos.entryPrice;
          const newHwm = isLong ? Math.max(hwm, price) : Math.min(hwm, price);
          const newSl = isLong
            ? newHwm * (1 - distance / 100)
            : newHwm * (1 + distance / 100);
          const slImproved = isLong ? newSl > pos.stopLoss : newSl < pos.stopLoss;
          if (newHwm !== hwm || slImproved) {
            await db.update(activePositionsTable).set({
              highWaterMark: newHwm,
              ...(slImproved ? { stopLoss: newSl } : {}),
            }).where(eq(activePositionsTable.id, pos.id));
            if (slImproved) {
              pos.stopLoss = newSl;
              await this.addLog(
                "info",
                `${pos.symbol} 트레일링 SL 업데이트 → $${newSl.toFixed(4)} (HWM $${newHwm.toFixed(4)})`,
                pos.symbol,
              );
            }
          }
        }
      }

      if (cfg.usePartialTp && !pos.partialTpDone) {
        const tpHit = isLong ? price >= pos.takeProfit : price <= pos.takeProfit;
        if (tpHit) {
          try {
            const positionSide = isLong ? "LONG" : "SHORT";
            const isPaperPos = pos.triggeredBy === "paper";
            let actualQty = pos.quantity;
            if (!isPaperPos) {
              try {
                const onEx = await exchangeService.getPositionAmount(pos.symbol, positionSide);
                if (onEx > 0) actualQty = onEx;
              } catch { /* fall back to DB */ }
            }
            const partPct = (cfg.partialTpPercent ?? 50) / 100;
            const closeQty = actualQty * partPct;
            if (closeQty > 0) {
              if (!isPaperPos) {
                await exchangeService.placeOrder(
                  pos.symbol,
                  isLong ? "sell" : "buy",
                  "market",
                  closeQty,
                  undefined,
                  { positionSide, reduceOnly: true },
                );
              }
              const realized = (price - pos.entryPrice) * closeQty * (isLong ? 1 : -1);
              await db.insert(tradeHistoryTable).values({
                symbol: pos.symbol,
                side: isLong ? "sell" : "buy",
                price,
                quantity: closeQty,
                total: price * closeQty,
                fee: price * closeQty * 0.001,
                pnl: realized,
                triggeredBy: isPaperPos ? "paper" : "bot",
              });
              const dir = isLong ? 1 : -1;
              const origTpDistanceAbs = Math.abs(pos.takeProfit - pos.entryPrice);
              const extendedTp = pos.entryPrice + dir * origTpDistanceAbs * 2;
              await db.update(activePositionsTable).set({
                quantity: actualQty - closeQty,
                stopLoss: pos.entryPrice,
                takeProfit: extendedTp,
                partialTpDone: true,
              }).where(eq(activePositionsTable.id, pos.id));
              pos.stopLoss = pos.entryPrice;
              pos.takeProfit = extendedTp;
              pos.quantity = actualQty - closeQty;
              const successMsg = `${isPaperPos ? "[가상] " : ""}부분 익절 ${pos.symbol} ${(partPct * 100).toFixed(0)}% @ $${price.toFixed(4)} | 실현 ${realized >= 0 ? "+" : ""}$${realized.toFixed(2)} | SL → 본전($${pos.entryPrice.toFixed(4)}) | 잔여 TP → $${extendedTp.toFixed(4)}`;
              await this.addLog("trade", successMsg, pos.symbol);
              await this.maybeNotify("info", `✅ ${successMsg}`, cfg, `partial-tp-ok-${pos.symbol}-${pos.id}`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await this.addLog("error", `부분 익절 실패 (${pos.symbol}): ${msg}`, pos.symbol);
            await this.maybeNotify("error", `부분 익절 실패 (${pos.symbol}): ${msg}`, cfg, `partial-tp-fail-${pos.symbol}`);
          }
        }
      }

      const tpHit = isLong ? price >= pos.takeProfit : price <= pos.takeProfit;
      const slHit = isLong ? price <= pos.stopLoss : price >= pos.stopLoss;

      if (!tpHit && !slHit) return;

      const exitReason = tpHit ? "TP" : "SL";
      const isPaperPos = pos.triggeredBy === "paper";
      try {
        const positionSide = isLong ? "LONG" : "SHORT";
        let actualQty = pos.quantity;
        if (!isPaperPos) {
          try {
            const onExchange = await exchangeService.getPositionAmount(pos.symbol, positionSide);
            if (onExchange <= 0) {
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
        }

        const leverage = cfg.leverage ?? 10;
        const closeQty = actualQty;
        const pnl = (price - pos.entryPrice) * closeQty * (isLong ? 1 : -1);
        const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100 * (isLong ? 1 : -1) * leverage;
        const holdSeconds = Math.max(0, Math.floor((Date.now() - pos.openedAt.getTime()) / 1000));

        await db.insert(tradeHistoryTable).values({
          symbol: pos.symbol,
          side: isLong ? "sell" : "buy",
          price,
          quantity: closeQty,
          total: price * closeQty,
          fee: price * closeQty * 0.001,
          pnl,
          triggeredBy: isPaperPos ? "paper" : "bot",
        });

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
          `${isPaperPos ? "[가상] " : ""}${exitReason} 청산: ${pos.symbol} @ $${price.toFixed(2)} | 진입 $${pos.entryPrice.toFixed(2)} | P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`,
          pos.symbol,
          isLong ? "SELL" : "BUY"
        );

        notifyExit({
          symbol: pos.symbol,
          side: pos.side,
          exitReason,
          entryPrice: pos.entryPrice,
          exitPrice: price,
          pnl,
          pnlPercent: pnlPct,
          holdMinutes: Math.floor(holdSeconds / 60),
          isPaper: isPaperPos,
        }).catch((err) => logger.warn({ err }, "Failed to send exit notification"));

        if (reflectionRow) {
          // ✅ 수정3: leverage 추가 (TP/SL 청산 시)
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
            leverage,
          }).catch((err) => logger.warn({ err, id: reflectionRow.id }, "Reflection lesson generation failed"));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.addLog("error", `포지션 청산 실패 (${pos.symbol}): ${msg}`, pos.symbol);
        await this.maybeNotify("error", `청산 실패 (${pos.symbol}): ${msg}`, cfg, `close-fail-${pos.symbol}`);
      }
    }));
  }

  private static readonly ROLE_SYSTEMS: Record<string, string> = {
    analyst: `당신은 암호화폐 트레이딩 봇의 Analyst Reflection Coach 입니다.
지난 종합 판단과 실제 시장 움직임을 대조해 교훈을 뽑아내는 역할입니다.
원칙: 결과론적 비난 금지. 놓친 단서와 과대평가한 근거를 분리 서술. 타이밍까지 평가.
출력: 마크다운 금지. 순수 한국어. 200자 이내. 마지막 줄은 반드시 "다음 체크리스트:" 로 시작.`,
    bull: `당신은 암호화폐 트레이딩 봇의 Bull Reflection Coach 입니다.
과거 상방 논거가 실제 가격과 얼마나 정합했는지 평가합니다.
원칙: 작동한 근거와 실패한 근거 분리. 하방 신호 중 맞아떨어진 것 인정. 다음 상방 신호 구체화.
출력: 마크다운 금지. 순수 한국어. 200자 이내. 마지막 줄은 반드시 "다음 체크리스트:" 로 시작.`,
    bear: `당신은 암호화폐 트레이딩 봇의 Bear Reflection Coach 입니다.
과거 하방 논거가 실제 가격과 얼마나 정합했는지 평가합니다.
원칙: 작동한 근거와 실패한 근거 분리. 상방 신호 중 맞아떨어진 것 인정. 다음 하방 신호 구체화.
출력: 마크다운 금지. 순수 한국어. 200자 이내. 마지막 줄은 반드시 "다음 체크리스트:" 로 시작.`,
    judge: `당신은 암호화폐 트레이딩 봇의 Judge Reflection Coach 입니다.
과거 최종 판정이 실제 결과와 일치했는지 평가합니다.
원칙: 판정 방향 일치 여부 평가. 강세/약세 중 어느 쪽이 더 정합했는지 사후 분석. 패턴 추출.
출력: 마크다운 금지. 순수 한국어. 200자 이내. 마지막 줄은 반드시 "다음 체크리스트:" 로 시작.`,
    aggressive: `당신은 암호화폐 트레이딩 봇의 Aggressive Risk Reflection Coach 입니다.
공격적 진입 판단이 실제 결과와 맞았는지 평가합니다.
원칙: 리스크 대비 수익 평가. 보수적 우려가 현실이 된 경우 인정. 공격적 진입 정당화 조건 정밀화.
출력: 마크다운 금지. 순수 한국어. 200자 이내. 마지막 줄은 반드시 "다음 체크리스트:" 로 시작.`,
    conservative: `당신은 암호화폐 트레이딩 봇의 Conservative Risk Reflection Coach 입니다.
보수적 판단이 실제 결과와 맞았는지 평가합니다.
원칙: 기회비용 vs 손실 방어 평가. 과도한 방어로 놓친 기회 인정. 보수적 관망 정당화 조건 정밀화.
출력: 마크다운 금지. 순수 한국어. 200자 이내. 마지막 줄은 반드시 "다음 체크리스트:" 로 시작.`,
    neutral: `당신은 암호화폐 트레이딩 봇의 Neutral Risk Reflection Coach 입니다.
균형적 판단이 R:R 관점에서 최적이었는지 평가합니다.
원칙: 중도 접근 효과 평가. 공격/보수 중 어느 쪽이 더 나은 결과를 냈는지 확인. 분할 전략 효과 평가.
출력: 마크다운 금지. 순수 한국어. 200자 이내. 마지막 줄은 반드시 "다음 체크리스트:" 로 시작.`,
  };

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
    leverage?: number;
    failureMessage?: string;
  }) {
    const isFailedEntry = ctx.exitReason === "ENTRY_FAILED";
    const verdict = isFailedEntry ? "진입실패" : ctx.exitReason === "TP" ? "성공(익절)" : "실패(손절)";
    const leverage = ctx.leverage ?? 10;
    const rawPnlPercent = ctx.pnlPercent / leverage;

    const tradeInfo = isFailedEntry
      ? `심볼: ${ctx.symbol} | 방향: ${ctx.side.toUpperCase()} | 결과: ${verdict}
진입시도가: $${ctx.entryPrice.toFixed(4)}
강세 다이버전스: ${ctx.bullishCount}개 / 약세: ${ctx.bearishCount}개
AI 신뢰도: ${ctx.originalConfidence !== null ? (ctx.originalConfidence * 100).toFixed(0) + "%" : "미상"}
예측 변동: ${ctx.originalExpectedMovePercent !== null ? (ctx.originalExpectedMovePercent >= 0 ? "+" : "") + ctx.originalExpectedMovePercent.toFixed(2) + "%" : "미상"}
진입 근거: ${ctx.originalReasoning ?? "기록 없음"}
실패 메시지: ${ctx.failureMessage ?? "알 수 없음"}`
      : `심볼: ${ctx.symbol} | 방향: ${ctx.side.toUpperCase()} | 결과: ${verdict}
손익: ${ctx.pnlPercent >= 0 ? "+" : ""}${ctx.pnlPercent.toFixed(2)}% (레버리지 ${leverage}배 적용 / 실제 가격 변동 ${rawPnlPercent >= 0 ? "+" : ""}${rawPnlPercent.toFixed(2)}%) | 보유: ${Math.floor(ctx.holdSeconds / 60)}분
진입가: $${ctx.entryPrice.toFixed(4)} → 청산가: $${ctx.exitPrice.toFixed(4)}
강세 다이버전스: ${ctx.bullishCount}개 / 약세: ${ctx.bearishCount}개
AI 신뢰도: ${ctx.originalConfidence !== null ? (ctx.originalConfidence * 100).toFixed(0) + "%" : "미상"}
예측 변동: ${ctx.originalExpectedMovePercent !== null ? (ctx.originalExpectedMovePercent >= 0 ? "+" : "") + ctx.originalExpectedMovePercent.toFixed(2) + "%" : "미상"}
진입 근거: ${ctx.originalReasoning ?? "기록 없음"}`;

    const roles = ["analyst", "bull", "bear", "judge", "aggressive", "conservative", "neutral"];
    const results = await Promise.allSettled(
      roles.map(async (role) => {
        const msg = await anthropic.messages.create({
          model: ANTHROPIC_MODEL,
          max_tokens: 512,
          system: BotManager.ROLE_SYSTEMS[role],
          messages: [{ role: "user", content: `다음 거래 결과에 대해 반성 노트를 작성하세요.\n\n${tradeInfo}` }],
        });
        const block = msg.content[0];
        return block && block.type === "text" ? `[${role}]\n${block.text.trim()}` : "";
      })
    );

    const lessonParts = results
      .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled" && !!r.value)
      .map((r) => r.value);

    if (lessonParts.length === 0) return;

    await db.update(tradeReflectionsTable)
      .set({ lessonText: lessonParts.join("\n\n") })
      .where(eq(tradeReflectionsTable.id, reflectionId))
      .catch((err) => logger.warn({ err, reflectionId }, "Failed to save reflection lesson"));
  }

  private async fetchRecentReflections(symbol: string): Promise<string> {
    try {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const rows = await db.select().from(tradeReflectionsTable)
        .where(and(
          eq(tradeReflectionsTable.symbol, symbol),
          gte(tradeReflectionsTable.createdAt, since),
        ))
        .orderBy(desc(tradeReflectionsTable.createdAt))
        .limit(6);

      if (rows.length === 0) return "  (아직 복기 데이터 없음)";

      return rows.map((r) => {
        const verdict = r.exitReason === "TP" ? "✓익절" : r.exitReason === "SL" ? "✗손절" : r.exitReason === "ENTRY_FAILED" ? "⚠진입실패" : r.exitReason;
        const pnlPart = `${r.pnlPercent >= 0 ? "+" : ""}${r.pnlPercent.toFixed(2)}%`;
        const lesson = r.lessonText ? r.lessonText.replace(/\s+/g, " ").trim() : "(복기 노트 생성 중)";
        return `  - [${verdict} ${pnlPart}] ${r.side.toUpperCase()} 강세${r.bullishCount}/약세${r.bearishCount}: ${lesson}`;
      }).join("\n");
    } catch (err) {
      logger.warn({ err }, "Failed to fetch reflections");
      return "  (복기 데이터 조회 실패)";
    }
  }

  private async fetchSignalStats(symbol: string): Promise<string> {
    try {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const rows = await db.select({
        side: tradeReflectionsTable.side,
        bullishCount: tradeReflectionsTable.bullishCount,
        bearishCount: tradeReflectionsTable.bearishCount,
        exitReason: tradeReflectionsTable.exitReason,
        pnlPercent: tradeReflectionsTable.pnlPercent,
      })
        .from(tradeReflectionsTable)
        .where(and(
          eq(tradeReflectionsTable.symbol, symbol),
          gte(tradeReflectionsTable.createdAt, since),
        ));

      if (rows.length < 5) return "  (통계 데이터 부족 — 5건 미만)";

      const bucket = (n: number) => Math.min(n, 4);
      type StatCell = { wins: number; total: number; pnlSum: number };
      const map = new Map<string, StatCell>();

      for (const r of rows) {
        if (r.exitReason === "ENTRY_FAILED") continue;
        const key = `${r.side}|b${bucket(r.bullishCount)}|s${bucket(r.bearishCount)}`;
        const cell = map.get(key) ?? { wins: 0, total: 0, pnlSum: 0 };
        cell.total++;
        if (r.exitReason === "TP") cell.wins++;
        cell.pnlSum += r.pnlPercent;
        map.set(key, cell);
      }

      if (map.size === 0) return "  (유효한 통계 없음)";

      const lines = [...map.entries()]
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 10)
        .map(([key, { wins, total, pnlSum }]) => {
          const [side, bPart, sPart] = key.split("|");
          const bull = bPart.replace("b", "");
          const bear = sPart.replace("s", "");
          const winRate = ((wins / total) * 100).toFixed(0);
          const avgPnl = (pnlSum / total).toFixed(2);
          const bullLabel = bull === "4" ? "4+" : bull;
          const bearLabel = bear === "4" ? "4+" : bear;
          return `  - ${side.toUpperCase()} 강세${bullLabel}/약세${bearLabel}: 승률 ${winRate}% (${wins}/${total}건) 평균손익 ${Number(avgPnl) >= 0 ? "+" : ""}${avgPnl}%`;
        });

      return lines.join("\n");
    } catch (err) {
      logger.warn({ err }, "Failed to fetch signal stats");
      return "  (통계 조회 실패)";
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
- Signal stats are based on real past trades for this symbol. If win rate < 50% for the current signal combination, lower confidence or prefer HOLD.

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

    const [reflections, signalStats] = await Promise.all([
      this.fetchRecentReflections(symbol),
      this.fetchSignalStats(symbol),
    ]);

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

신호 조합별 실적 통계 (30일, 이 심볼 한정 — 숫자 근거로 삼을 것):
${signalStats}

최근 거래 복기 (7일, 구체적 교훈 — 비슷한 조건이면 패턴을 따르고 반복 손절 조합은 회피):
${reflections}

Predict the next ~10–20 candle price move and decide BUY/SELL/HOLD with TP/SL.
승률이 낮은 신호 조합(<50%)이면 confidence를 낮추거나 HOLD를 우선하세요.
위 복기 노트의 교훈을 반드시 reasoning에 1번 이상 반영하세요.
중요: 복기 데이터가 20건 미만이면 복기 노트와 통계는 완전히 무시하고 현재 기술적 신호(다이버전스 강도, ATR, 펀딩비)만으로 판단하세요. 데이터 부족 상태에서 과거 손절 패턴을 일반화하지 마세요. confidence는 신호 강도와 ATR만 기준으로 산출하세요.
    const message = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const block = message.content[0];
    const content = block && block.type === "text" ? block.text : "";
    if (!content) throw new Error("Empty AI response");

    let parsed: ReturnType<typeof JSON.parse>;
    try {
      parsed = JSON.parse(extractJson(content));
    } catch {
      logger.warn({ content }, "Failed to parse AI JSON response");
      throw new Error("AI response JSON parse failed");
    }

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
