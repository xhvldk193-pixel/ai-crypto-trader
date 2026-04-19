import { Router } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";
import { db, aiSignalsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { exchangeService } from "../lib/exchange";
import { computeAtrPercent } from "../lib/indicators";

const router = Router();

router.post("/signal", async (req, res) => {
  const { symbol, timeframe, divergenceData, currentPrice, change24h } = req.body;
  if (!symbol || currentPrice === undefined) {
    res.status(400).json({ error: "symbol and currentPrice required" }); return;
  }

  try {
    // Pull recent candles to compute ATR-based volatility for the AI prompt
    let atrPercent: number | null = null;
    try {
      const candles = await exchangeService.getOhlcv(symbol, timeframe || "15m", 100);
      atrPercent = computeAtrPercent(candles, 14);
    } catch (err) {
      req.log.warn({ err }, "Failed to compute ATR for AI signal");
    }

    const signals = (divergenceData?.signals ?? []) as Array<{
      indicator: string; type: string; strength: number; description: string;
    }>;
    const avgBullishStrength = avgStrength(signals.filter(s => s.type.startsWith("positive")));
    const avgBearishStrength = avgStrength(signals.filter(s => s.type.startsWith("negative")));

    const systemPrompt = `You are an expert crypto trading assistant specialized in divergence-based scalping on the ${timeframe || "15m"} timeframe.
You analyze divergence signals from indicators (MACD, RSI, Stochastic, CCI, Momentum, OBV, VWMACD, CMF, MFI) to determine trades.
Divergence types:
- positive_regular: Price lower low, indicator higher low → Bullish reversal
- negative_regular: Price higher high, indicator lower high → Bearish reversal
- positive_hidden: Price higher low, indicator lower low → Bullish continuation
- negative_hidden: Price lower high, indicator higher high → Bearish continuation

Your job:
1. Decide BUY / SELL / HOLD based on overall divergence bias and strength.
2. Predict an expected price-move magnitude over the next ~10–20 candles of the given timeframe. Use the divergence strength (more & stronger confirming indicators → larger move) and recent ATR volatility as a sanity bound. Typical 15m moves: 0.3%–2.5%; strong setups can reach 3–5%.
3. From the predicted move, set:
   - suggestedEntryPrice: usually the current price (slight pullback for BUY, slight bounce for SELL is fine)
   - suggestedTakeProfit: entry ± expected move (BUY: +, SELL: -)
   - suggestedStopLoss: opposite side, sized smaller than TP to keep R/R ≥ 1.3 (typically 0.4–0.7× of expected move)
4. Confidence reflects how aligned and strong the signals are.
5. expectedMovePercent must be SIGNED: positive for BUY (price rises), negative for SELL (price falls), 0 for HOLD.

Respond ONLY with valid JSON matching this exact schema:
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": number (0.0-1.0),
  "reasoning": string (Korean, 2-3 sentences explaining the signal, the predicted move, and the chosen TP/SL),
  "riskLevel": "low" | "medium" | "high",
  "expectedMovePercent": number,
  "suggestedEntryPrice": number,
  "suggestedStopLoss": number,
  "suggestedTakeProfit": number
}`;

    const userMessage = `Analyze ${symbol} on ${timeframe || "15m"} timeframe.
Current Price: $${currentPrice}
24h Change: ${change24h !== undefined ? `${change24h > 0 ? "+" : ""}${Number(change24h).toFixed(2)}%` : "N/A"}
Recent ATR (volatility): ${atrPercent !== null ? `${atrPercent.toFixed(2)}% of price` : "unknown"}

Divergence Analysis:
${divergenceData ? `- Overall Bias: ${divergenceData.overallBias}
- Bullish Signals: ${divergenceData.bullishCount} (avg strength ${avgBullishStrength.toFixed(2)})
- Bearish Signals: ${divergenceData.bearishCount} (avg strength ${avgBearishStrength.toFixed(2)})
- Active Signals: ${signals.map(s => `${s.indicator}/${s.type}@${s.strength.toFixed(2)}`).join(", ") || "none"}` : "No divergence data."}

Predict the next ~10–20 candle price move and set TP/SL accordingly.`;

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
    if (!content) throw new Error("Empty response from AI");

    const parsed = JSON.parse(content);
    const rawAction = String(parsed.action ?? "HOLD").toUpperCase();
    const action: "BUY" | "SELL" | "HOLD" =
      rawAction === "BUY" || rawAction === "SELL" ? rawAction : "HOLD";
    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5));
    const entryPrice = Number(parsed.suggestedEntryPrice) || Number(currentPrice);
    let expectedMovePercent = Number.isFinite(parsed.expectedMovePercent) ? Number(parsed.expectedMovePercent) : 0;
    if (action === "HOLD") expectedMovePercent = 0;

    let takeProfit = Number(parsed.suggestedTakeProfit);
    let stopLoss = Number(parsed.suggestedStopLoss);
    // Sanity defaults if AI omits TP/SL
    if (action !== "HOLD" && (!Number.isFinite(takeProfit) || !Number.isFinite(stopLoss))) {
      const moveAbs = Math.abs(expectedMovePercent) / 100 || (atrPercent ?? 1) / 100;
      const dir = action === "BUY" ? 1 : -1;
      takeProfit = entryPrice * (1 + dir * moveAbs);
      stopLoss = entryPrice * (1 - dir * moveAbs * 0.5);
    }

    const expectedMoveUsd = (expectedMovePercent / 100) * entryPrice;

    res.json({
      action,
      confidence,
      reasoning: parsed.reasoning || "분석 결과가 제공되지 않았습니다.",
      riskLevel: parsed.riskLevel || "medium",
      suggestedEntryPrice: entryPrice,
      suggestedStopLoss: action === "HOLD" ? null : stopLoss,
      suggestedTakeProfit: action === "HOLD" ? null : takeProfit,
      expectedMovePercent,
      expectedMoveUsd,
      atrPercent: atrPercent ?? undefined,
      analyzedAt: Date.now(),
    });
  } catch (err) {
    req.log.error({ err }, "AI signal failed");
    res.status(500).json({ error: "AI analysis failed" });
  }
});

router.get("/latest-signal", async (req, res) => {
  try {
    const rows = await db.select().from(aiSignalsTable).orderBy(desc(aiSignalsTable.createdAt)).limit(1);
    if (rows.length === 0) {
      res.json({}); return;
    }
    const r = rows[0];
    res.json({ signal: {
      id: String(r.id),
      symbol: r.symbol,
      timeframe: r.timeframe,
      action: r.action,
      confidence: r.confidence,
      riskLevel: r.riskLevel,
      currentPrice: r.currentPrice,
      entryPrice: r.entryPrice,
      takeProfit: r.takeProfit,
      stopLoss: r.stopLoss,
      expectedMovePercent: r.expectedMovePercent,
      expectedMoveUsd: r.expectedMoveUsd,
      reasoning: r.reasoning,
      bullishCount: r.bullishCount,
      bearishCount: r.bearishCount,
      createdAt: r.createdAt.getTime(),
    } });
  } catch (err) {
    req.log.error({ err }, "Failed to load latest AI signal");
    res.status(500).json({ error: "Failed to load latest AI signal" });
  }
});

function avgStrength(items: Array<{ strength: number }>): number {
  if (items.length === 0) return 0;
  return items.reduce((a, b) => a + b.strength, 0) / items.length;
}

export default router;
