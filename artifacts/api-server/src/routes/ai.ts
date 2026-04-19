import { Router } from "express";
import { openai } from "@workspace/integrations-openai-ai-server";

const router = Router();

router.post("/signal", async (req, res) => {
  const { symbol, timeframe, divergenceData, currentPrice, change24h } = req.body;
  if (!symbol || currentPrice === undefined) {
    res.status(400).json({ error: "symbol and currentPrice required" }); return;
  }

  try {
    const systemPrompt = `You are an expert crypto trading assistant specialized in technical analysis.
You analyze divergence signals from multiple indicators (MACD, RSI, Stochastic, CCI, Momentum, OBV, VWMACD, CMF, MFI) to determine trading signals.
Divergence types:
- positive_regular: Price makes lower low, indicator makes higher low → Bullish reversal signal
- negative_regular: Price makes higher high, indicator makes lower high → Bearish reversal signal  
- positive_hidden: Price makes higher low, indicator makes lower low → Bullish continuation signal
- negative_hidden: Price makes lower high, indicator makes higher high → Bearish continuation signal

Respond ONLY with valid JSON matching this exact schema:
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": number (0.0-1.0),
  "reasoning": string (2-3 sentences explaining the signal),
  "riskLevel": "low" | "medium" | "high",
  "suggestedEntryPrice": number | null,
  "suggestedStopLoss": number | null,
  "suggestedTakeProfit": number | null
}`;

    const userMessage = `Analyze the following market data for ${symbol} on ${timeframe} timeframe:
Current Price: $${currentPrice}
24h Change: ${change24h !== undefined ? `${change24h > 0 ? "+" : ""}${change24h.toFixed(2)}%` : "N/A"}
${divergenceData ? `
Divergence Analysis:
- Overall Bias: ${divergenceData.overallBias}
- Bullish Signals: ${divergenceData.bullishCount}
- Bearish Signals: ${divergenceData.bearishCount}
- Active Signals: ${divergenceData.signals?.map((s: { indicator: string; type: string; strength: number; description: string }) => `${s.indicator} (${s.type}, strength: ${s.strength.toFixed(2)})`).join(", ") || "none"}
` : "No divergence data available."}

Based on this analysis, provide a trading signal.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 512,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      response_format: { type: "json_object" }
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error("Empty response from AI");

    const parsed = JSON.parse(content);
    
    res.json({
      action: parsed.action || "HOLD",
      confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
      reasoning: parsed.reasoning || "No reasoning provided",
      riskLevel: parsed.riskLevel || "medium",
      suggestedEntryPrice: parsed.suggestedEntryPrice ?? currentPrice,
      suggestedStopLoss: parsed.suggestedStopLoss ?? null,
      suggestedTakeProfit: parsed.suggestedTakeProfit ?? null,
      analyzedAt: Date.now(),
    });
  } catch (err) {
    req.log.error({ err }, "AI signal failed");
    res.status(500).json({ error: "AI analysis failed" });
  }
});

export default router;
