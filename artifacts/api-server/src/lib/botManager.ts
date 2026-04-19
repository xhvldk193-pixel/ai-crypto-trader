import { db } from "@workspace/db";
import { botConfigTable, botLogsTable, tradeHistoryTable } from "@workspace/db";
import { exchangeService } from "./exchange";
import { analyzeDivergences } from "./divergence";
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

class BotManager {
  private running = false;
  private startTime: number | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private totalSignals = 0;
  private executedTrades = 0;
  private lastSignal = "HOLD";
  private lastCheckedAt: number | null = null;

  getStatus(): BotStatus {
    const rows = { symbol: "BTC/USDT", timeframe: "1h" };
    return {
      running: this.running,
      uptime: this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
      symbol: rows.symbol,
      timeframe: rows.timeframe,
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
    
    await this.addLog("info", "Trading bot started");
    
    const config = await this.getConfig();
    this.intervalId = setInterval(() => this.tick(), config.checkIntervalSeconds * 1000);
    
    // Run first tick immediately
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
    this.addLog("info", "Trading bot stopped").catch(() => {});
  }

  async reloadConfig() {
    if (!this.running) return;
    const config = await this.getConfig();
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = setInterval(() => this.tick(), config.checkIntervalSeconds * 1000);
    await this.addLog("info", `Bot config reloaded: ${config.symbol} ${config.timeframe}`);
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
    try {
      const config = await this.getConfig();
      this.lastCheckedAt = Date.now();
      
      // Get market data
      const ticker = await exchangeService.getTicker(config.symbol);
      const candles = await exchangeService.getOhlcv(config.symbol, config.timeframe, 200);
      
      if (candles.length < 50) {
        await this.addLog("warning", `Insufficient candle data for ${config.symbol}`);
        return;
      }

      // Analyze divergences
      const divergence = analyzeDivergences(candles, config.symbol, config.timeframe);
      
      // Get AI signal
      const systemPrompt = `You are a crypto trading bot. Analyze divergence signals and return a JSON trading decision.
Respond ONLY with: {"action":"BUY"|"SELL"|"HOLD","confidence":0.0-1.0,"reasoning":"brief reason"}`;
      
      const completion = await openai.chat.completions.create({
        model: "gpt-5.2",
        max_completion_tokens: 256,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Symbol: ${config.symbol}, Price: $${ticker.price.toFixed(2)}, Bias: ${divergence.overallBias}, Bullish signals: ${divergence.bullishCount}, Bearish signals: ${divergence.bearishCount}` }
        ],
        response_format: { type: "json_object" }
      });

      const content = completion.choices[0]?.message?.content;
      if (!content) return;
      
      const parsed = JSON.parse(content) as { action: string; confidence: number; reasoning: string };
      this.lastSignal = parsed.action;
      
      if (parsed.action !== "HOLD") {
        this.totalSignals++;
        await this.addLog(
          "trade",
          `Signal: ${parsed.action} (confidence: ${(parsed.confidence * 100).toFixed(0)}%) — ${parsed.reasoning}`,
          config.symbol,
          parsed.action
        );
      } else {
        await this.addLog("info", `Checked ${config.symbol} @ $${ticker.price.toFixed(2)} — HOLD (bias: ${divergence.overallBias})`);
      }

      // Execute trade if autoTrade is enabled and confidence threshold met
      if (config.autoTrade && parsed.action !== "HOLD" && parsed.confidence >= config.minConfidence) {
        try {
          const order = await exchangeService.placeOrder(
            config.symbol,
            parsed.action.toLowerCase(),
            "market",
            config.tradeAmount / ticker.price
          );
          this.executedTrades++;
          
          await db.insert(tradeHistoryTable).values({
            symbol: config.symbol,
            side: parsed.action.toLowerCase(),
            price: ticker.price,
            quantity: config.tradeAmount / ticker.price,
            total: config.tradeAmount,
            fee: config.tradeAmount * 0.001,
            pnl: 0,
            triggeredBy: "bot",
            exchangeOrderId: order.id,
          });
          
          await this.addLog("trade", `Executed ${parsed.action} ${config.symbol} @ $${ticker.price.toFixed(2)}`, config.symbol, parsed.action);
        } catch (err) {
          await this.addLog("error", `Trade execution failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      logger.error({ err }, "Bot tick error");
      await this.addLog("error", `Bot tick error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    }
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
