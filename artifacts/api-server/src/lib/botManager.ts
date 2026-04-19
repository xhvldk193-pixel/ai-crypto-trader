import { db } from "@workspace/db";
import { botConfigTable, botLogsTable, tradeHistoryTable, activePositionsTable, aiSignalsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { exchangeService } from "./exchange";
import { analyzeDivergences } from "./divergence";
import { computeAtrPercent } from "./indicators";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger";

interface BotStatus {
  running: boolean;
  uptime: number;
  symbol?: string;
  timeframe?: string;
  lastSignal?: string;
  lastCheckedAt?: number;
  totalSignals: number;
  executedTrades: number;
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

class BotManager {
  private running = false;
  private startTime: number | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private totalSignals = 0;
  private executedTrades = 0;
  private lastSignal = "HOLD";
  private lastCheckedAt: number | null = null;
  private currentSymbol = "BTC/USDT";
  private currentTimeframe = "15m";
  private tickInFlight = false;

  getStatus(): BotStatus {
    return {
      running: this.running,
      uptime: this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
      symbol: this.currentSymbol,
      timeframe: this.currentTimeframe,
      lastSignal: this.lastSignal,
      lastCheckedAt: this.lastCheckedAt ?? undefined,
      totalSignals: this.totalSignals,
      executedTrades: this.executedTrades,
    };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.startTime = Date.now();

    await this.addLog("info", "트레이딩 봇이 시작되었습니다.");

    const config = await this.getConfig();
    this.currentSymbol = config.symbol;
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
    this.currentSymbol = config.symbol;
    this.currentTimeframe = config.timeframe;
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = setInterval(() => this.tick(), config.checkIntervalSeconds * 1000);
    await this.addLog("info", `봇 설정이 재로딩되었습니다: ${config.symbol} ${config.timeframe}`);
  }

  private async getConfig() {
    const rows = await db.select().from(botConfigTable).limit(1);
    if (rows.length === 0) {
      const [created] = await db.insert(botConfigTable).values({}).returning();
      return created;
    }
    return rows[0];
  }

  private async tick() {
    if (!this.running) return;
    if (this.tickInFlight) return; // single-flight guard against overlapping ticks
    this.tickInFlight = true;
    try {
      const config = await this.getConfig();
      this.currentSymbol = config.symbol;
      this.currentTimeframe = config.timeframe;
      this.lastCheckedAt = Date.now();

      const ticker = await exchangeService.getTicker(config.symbol);
      const candles = await exchangeService.getOhlcv(config.symbol, config.timeframe, 200);

      if (candles.length < 50) {
        await this.addLog("warning", `${config.symbol} 캔들 데이터 부족`);
        return;
      }

      // First, manage any existing tracked positions for TP/SL exit
      await this.manageActivePositions(ticker.price);

      // Analyze divergences
      const divergence = analyzeDivergences(candles, config.symbol, config.timeframe);
      const hasDivergence = divergence.bullishCount > 0 || divergence.bearishCount > 0;

      if (!hasDivergence) {
        await this.addLog("info", `${config.symbol} @ $${ticker.price.toFixed(2)} — 다이버전스 없음 (관망)`);
        this.lastSignal = "HOLD";
        return;
      }

      // Get AI decision
      const atrPercent = computeAtrPercent(candles, 14);
      const rawDecision = await this.getAiDecision({
        symbol: config.symbol,
        timeframe: config.timeframe,
        currentPrice: ticker.price,
        change24h: ticker.changePercent24h,
        atrPercent,
        divergence,
      });
      // Hard server-side guardrails (don't trust prompt-only safety)
      const decision = this.sanitizeDecision(rawDecision, ticker.price, atrPercent);

      this.lastSignal = decision.action;

      // Persist signal
      await db.insert(aiSignalsTable).values({
        symbol: config.symbol,
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
          `${config.symbol} @ $${ticker.price.toFixed(2)} — 관망 (강세 ${divergence.bullishCount} / 약세 ${divergence.bearishCount})`
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
        config.symbol,
        decision.action
      );

      // Execute trade if autoTrade is enabled and confidence threshold met
      if (config.autoTrade && decision.confidence >= config.minConfidence) {
        const dir = decision.action === "BUY" ? 1 : -1;
        const side = decision.action === "BUY" ? "long" : "short";

        // Determine TP/SL
        const entryPrice = ticker.price;
        let takeProfit: number;
        let stopLoss: number;
        if (config.useAiTargets && decision.suggestedTakeProfit !== null && decision.suggestedStopLoss !== null) {
          takeProfit = decision.suggestedTakeProfit;
          stopLoss = decision.suggestedStopLoss;
        } else {
          takeProfit = entryPrice * (1 + dir * config.takeProfitPercent / 100);
          stopLoss = entryPrice * (1 - dir * config.stopLossPercent / 100);
        }

        // Atomic entry: re-check existing position inside a transaction to prevent
        // concurrent ticks (or external writers) from creating duplicates.
        let positionInserted = false;
        try {
          await db.transaction(async (tx) => {
            const existing = await tx.select().from(activePositionsTable).where(eq(activePositionsTable.symbol, config.symbol));
            if (existing.length > 0) {
              return; // skip silently; logged below
            }
            const quantity = config.tradeAmount / entryPrice;
            await tx.insert(activePositionsTable).values({
              symbol: config.symbol,
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
          await this.addLog("error", `포지션 등록 실패: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }

        if (!positionInserted) {
          await this.addLog("info", `${config.symbol} 이미 포지션 보유 중 — 신규 진입 건너뜀`);
          return;
        }

        // Place the order only after we've reserved the active-position slot
        try {
          const quantity = config.tradeAmount / entryPrice;
          const order = await exchangeService.placeOrder(
            config.symbol,
            decision.action.toLowerCase(),
            "market",
            quantity
          );
          this.executedTrades++;

          await db.insert(tradeHistoryTable).values({
            symbol: config.symbol,
            side: decision.action.toLowerCase(),
            price: entryPrice,
            quantity,
            total: config.tradeAmount,
            fee: config.tradeAmount * 0.001,
            pnl: 0,
            triggeredBy: "bot",
            exchangeOrderId: order.id,
          });

          await this.addLog(
            "trade",
            `진입 ${decision.action} ${config.symbol} @ $${entryPrice.toFixed(2)} | TP $${takeProfit.toFixed(2)} / SL $${stopLoss.toFixed(2)}`,
            config.symbol,
            decision.action
          );
        } catch (err) {
          // Roll back the active-position reservation if the order failed.
          await db.delete(activePositionsTable).where(eq(activePositionsTable.symbol, config.symbol)).catch(() => {});
          await this.addLog("error", `거래 실행 실패: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      logger.error({ err }, "Bot tick error");
      await this.addLog("error", `봇 틱 오류: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    } finally {
      this.tickInFlight = false;
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

    // Clamp expected move to a sane envelope (0.2%–6% magnitude)
    let movePct = decision.expectedMovePercent;
    if (!Number.isFinite(movePct)) movePct = 0;
    // Force sign to match action
    if (dir === 1 && movePct < 0) movePct = Math.abs(movePct);
    if (dir === -1 && movePct > 0) movePct = -Math.abs(movePct);
    const absMove = Math.min(6, Math.max(0.2, Math.abs(movePct)));
    movePct = dir * absMove;

    let entry = decision.suggestedEntryPrice;
    if (!Number.isFinite(entry) || entry <= 0) entry = currentPrice;
    // Clamp entry to within ±0.5% of current to avoid bad fills
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

    // Enforce min stop distance (use ATR or 0.15% floor) to avoid instant SL hits
    const minStopPct = Math.max(0.0015, (atrPercent ?? 0.3) / 100 * 0.5);
    const slDistance = Math.abs((sl as number) - entry) / entry;
    if (slDistance < minStopPct) {
      sl = entry * (1 - dir * minStopPct);
    }
    // Enforce min RR ≥ 1.2
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
  private async manageActivePositions(currentPrice?: number) {
    const positions = await db.select().from(activePositionsTable);
    if (positions.length === 0) return;

    for (const pos of positions) {
      const price = pos.symbol === this.currentSymbol && currentPrice
        ? currentPrice
        : (await exchangeService.getTicker(pos.symbol)).price;

      const isLong = pos.side === "long";
      const tpHit = isLong ? price >= pos.takeProfit : price <= pos.takeProfit;
      const slHit = isLong ? price <= pos.stopLoss : price >= pos.stopLoss;

      if (!tpHit && !slHit) continue;

      const exitReason = tpHit ? "TP" : "SL";
      try {
        await exchangeService.placeOrder(
          pos.symbol,
          isLong ? "sell" : "buy",
          "market",
          pos.quantity
        );
        const pnl = (price - pos.entryPrice) * pos.quantity * (isLong ? 1 : -1);
        const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100 * (isLong ? 1 : -1);

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

        await db.delete(activePositionsTable).where(eq(activePositionsTable.id, pos.id));

        await this.addLog(
          exitReason === "TP" ? "trade" : "warning",
          `${exitReason} 청산: ${pos.symbol} @ $${price.toFixed(2)} | 진입 $${pos.entryPrice.toFixed(2)} | P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`,
          pos.symbol,
          isLong ? "SELL" : "BUY"
        );
      } catch (err) {
        await this.addLog("error", `포지션 청산 실패 (${pos.symbol}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async getAiDecision(input: {
    symbol: string;
    timeframe: string;
    currentPrice: number;
    change24h: number;
    atrPercent: number | null;
    divergence: ReturnType<typeof analyzeDivergences>;
  }): Promise<AiDecision> {
    const { symbol, timeframe, currentPrice, change24h, atrPercent, divergence } = input;

    const systemPrompt = `You are an expert crypto trading bot specialized in divergence-based scalping on the ${timeframe} timeframe.
Use multi-indicator divergence signals (MACD, RSI, Stoch, CCI, MOM, OBV) and recent ATR volatility to predict the next ~10–20 candle price move.

Rules:
- expectedMovePercent must be SIGNED: positive for bullish (BUY), negative for bearish (SELL), 0 for HOLD.
- Typical 15m moves: 0.3%–2.5%; strong multi-indicator setups can reach 3–5%.
- suggestedTakeProfit = entryPrice × (1 + expectedMovePercent/100).
- suggestedStopLoss is on the opposite side, sized 0.4–0.7× of |expectedMovePercent| to keep R/R ≥ 1.3.
- suggestedEntryPrice can equal the current price.
- Set HOLD if signals are weak/conflicting.

Reasoning must be in Korean and explain (1) the dominant divergence direction & strength, (2) the predicted move, (3) why these TP/SL.

Respond ONLY with valid JSON:
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
    const userMessage = `Symbol: ${symbol}
Timeframe: ${timeframe}
Current Price: $${currentPrice.toFixed(2)}
24h Change: ${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%
ATR (volatility): ${atrPercent !== null ? `${atrPercent.toFixed(2)}% of price` : "unknown"}

Divergence Bias: ${divergence.overallBias}
Bullish signals: ${divergence.bullishCount}
Bearish signals: ${divergence.bearishCount}
Active: ${sigList}

Predict the next ~10–20 candle price move and decide BUY/SELL/HOLD with TP/SL.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 700,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      response_format: { type: "json_object" }
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error("Empty AI response");

    const parsed = JSON.parse(content);
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
