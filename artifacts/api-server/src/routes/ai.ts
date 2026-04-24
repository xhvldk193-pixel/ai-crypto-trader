import { Router } from "express";
import rateLimit from "express-rate-limit";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db, aiSignalsTable, botConfigTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { exchangeService } from "../lib/exchange";
import { computeAtrPercent } from "../lib/indicators";
// ✅ 서버측에서 직접 계산 — 클라이언트 입력 신뢰 금지
import { analyzeDivergences } from "../lib/divergence";
import { getMacroContext, formatMacroForPrompt } from "../lib/macro";

const router = Router();

const ANTHROPIC_MODEL = "claude-haiku-4-5";

// ✅ Rate limit — AI 호출은 토큰 비용이 크므로 분당 10회 제한
const aiSignalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many AI signal requests, please wait a moment." },
});

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return text.trim();
}

async function getMtfBias(symbol: string, timeframes: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(timeframes.map(async (tf) => {
    try {
      const candles = await exchangeService.getOhlcv(symbol, tf, 200);
      if (candles.length < 50) { out[tf] = "neutral"; return; }
      const div = analyzeDivergences(candles, symbol, tf);
      out[tf] = div.overallBias;
    } catch {
      out[tf] = "neutral";
    }
  }));
  return out;
}

function avgStrength(items: Array<{ strength: number }>): number {
  if (items.length === 0) return 0;
  return items.reduce((a, b) => a + b.strength, 0) / items.length;
}

// ✅ Rate limit 적용 + 입력 검증 강화 + 서버측 다이버전스 계산
router.post("/signal", aiSignalLimiter, async (req, res) => {
  const { symbol, timeframe, currentPrice, change24h } = req.body ?? {};

  // ✅ 입력 검증
  if (typeof symbol !== "string" || symbol.trim().length === 0) {
    res.status(400).json({ error: "symbol must be a non-empty string" }); return;
  }
  const cpNum = Number(currentPrice);
  if (!Number.isFinite(cpNum) || cpNum <= 0) {
    res.status(400).json({ error: "currentPrice must be a positive finite number" }); return;
  }
  const tf = typeof timeframe === "string" && timeframe.trim().length > 0
    ? timeframe.trim() : "15m";

  try {
    // ✅ 서버에서 직접 캔들 가져와서 다이버전스 계산 — 클라이언트 조작 불가
    let atrPercent: number | null = null;
    let divergenceResult: ReturnType<typeof analyzeDivergences> | null = null;
    try {
      const candles = await exchangeService.getOhlcv(symbol, tf, 200);
      if (candles.length >= 50) {
        divergenceResult = analyzeDivergences(candles, symbol, tf);
        atrPercent = computeAtrPercent(candles, 14);
      }
    } catch (err) {
      req.log.warn({ err }, "Failed to compute divergence/ATR for AI signal");
    }

    const cfgRows = await db.select().from(botConfigTable).limit(1);
    const cfg = cfgRows[0];
    const mtfTfs = cfg?.useMtfFilter
      ? ((cfg.mtfTimeframes as string[]) ?? ["1h", "4h"])
      : [];

    const [mtf, fundingRate, openInterest, macroData] = await Promise.all([
      mtfTfs.length > 0 ? getMtfBias(symbol, mtfTfs) : Promise.resolve({} as Record<string, string>),
      cfg?.useFundingRate !== false ? exchangeService.getFundingRate(symbol) : Promise.resolve(null),
      cfg?.useFundingRate !== false ? exchangeService.getOpenInterest(symbol) : Promise.resolve(null),
      getMacroContext(),
    ]);

    const signals = divergenceResult?.signals ?? [];
    const avgBullishStrength = avgStrength(signals.filter(s => s.type.startsWith("positive")));
    const avgBearishStrength = avgStrength(signals.filter(s => s.type.startsWith("negative")));

    const mtfText = Object.keys(mtf).length > 0
      ? Object.entries(mtf).map(([tfKey, b]) => `  - ${tfKey}: ${b}`).join("\n")
      : "  (disabled)";
    const fundingText = fundingRate !== null
      ? `Funding rate: ${(fundingRate * 100).toFixed(4)}%`
      : "Funding rate: unavailable";
    const oiText = openInterest !== null
      ? `Open interest: ${openInterest.toLocaleString()} contracts`
      : "Open interest: unavailable";

    const systemPrompt = `You are an expert crypto trading assistant specialized in divergence-based scalping on the ${tf} timeframe.
You analyze divergence signals from indicators (MACD, RSI, Stochastic, CCI, Momentum, OBV, VWMACD, CMF, MFI) to determine trades.
Divergence types:
- positive_regular: Price lower low, indicator higher low → Bullish reversal
- negative_regular: Price higher high, indicator lower high → Bearish reversal
- positive_hidden: Price higher low, indicator lower low → Bullish continuation
- negative_hidden: Price lower high, indicator higher high → Bearish continuation

Your job:
1. Decide BUY / SELL / HOLD based on overall divergence bias and strength.
2. Respect the multi-timeframe (MTF) bias on higher timeframes — if higher TFs strongly disagree with the primary signal, prefer HOLD or reduce confidence.
3. Use funding rate as a contrarian sentiment cue (very positive funding → crowded longs, slight bearish bias; very negative → crowded shorts, slight bullish bias).
4. Factor in macro environment — high real rates or strong DXY are headwinds for BTC; extreme fear can be a contrarian buy signal; low stablecoin liquidity limits upside.
5. Predict an expected price-move magnitude over the next ~10–20 candles. Use divergence strength + recent ATR as a sanity bound. Typical 15m moves: 0.3%–2.5%; strong setups 3–5%.
6. From the predicted move, set:
   - suggestedEntryPrice: usually the current price
   - suggestedTakeProfit: entry ± expected move (BUY: +, SELL: -)
   - suggestedStopLoss: opposite side, sized smaller than TP to keep R/R ≥ 1.3 (typically 0.4–0.7× of expected move)
7. expectedMovePercent must be SIGNED: positive for BUY, negative for SELL, 0 for HOLD.

Respond ONLY with valid JSON (no prose, no markdown fences) matching this exact schema:
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": number (0.0-1.0),
  "reasoning": string (Korean, 2-3 sentences explaining the signal, MTF/funding context, macro environment, predicted move, and chosen TP/SL),
  "riskLevel": "low" | "medium" | "high",
  "expectedMovePercent": number,
  "suggestedEntryPrice": number,
  "suggestedStopLoss": number,
  "suggestedTakeProfit": number
}`;

    const userMessage = `Analyze ${symbol} on ${tf} timeframe.
Current Price: $${cpNum}
24h Change: ${change24h !== undefined ? `${Number(change24h) > 0 ? "+" : ""}${Number(change24h).toFixed(2)}%` : "N/A"}
Recent ATR (volatility): ${atrPercent !== null ? `${atrPercent.toFixed(2)}% of price` : "unknown"}

Divergence Analysis (primary TF):
${divergenceResult ? `- Overall Bias: ${divergenceResult.overallBias}
- Bullish Signals: ${divergenceResult.bullishCount} (avg strength ${avgBullishStrength.toFixed(2)})
- Bearish Signals: ${divergenceResult.bearishCount} (avg strength ${avgBearishStrength.toFixed(2)})
- Active Signals: ${signals.map(s => `${s.indicator}/${s.type}@${s.strength.toFixed(2)}`).join(", ") || "none"}` : "No divergence data available."}

Multi-Timeframe Bias:
${mtfText}

Futures context:
${fundingText}
${oiText}

Macro Environment:
${formatMacroForPrompt(macroData)}

Predict the next ~10–20 candle price move and set TP/SL accordingly.`;

    const message = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const block = message.content[0];
    const content = block && block.type === "text" ? block.text : "";
    if (!content) throw new Error("Empty response from AI");

    const parsed = JSON.parse(extractJson(content));
    const rawAction = String(parsed.action ?? "HOLD").toUpperCase();
    const action: "BUY" | "SELL" | "HOLD" =
      rawAction === "BUY" || rawAction === "SELL" ? rawAction : "HOLD";
    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5));
    const entryPrice = Number(parsed.suggestedEntryPrice) || cpNum;
    let expectedMovePercent = Number.isFinite(parsed.expectedMovePercent)
      ? Number(parsed.expectedMovePercent) : 0;
    if (action === "HOLD") expectedMovePercent = 0;

    let takeProfit = Number(parsed.suggestedTakeProfit);
    let stopLoss = Number(parsed.suggestedStopLoss);
    if (action !== "HOLD" && (!Number.isFinite(takeProfit) || !Number.isFinite(stopLoss))) {
      const moveAbs = Math.abs(expectedMovePercent) / 100 || (atrPercent ?? 1) / 100;
      const dir = action === "BUY" ? 1 : -1;
      takeProfit = entryPrice * (1 + dir * moveAbs);
      stopLoss = entryPrice * (1 - dir * moveAbs * 0.5);
    }

    res.json({
      action,
      confidence,
      reasoning: parsed.reasoning || "분석 결과가 제공되지 않았습니다.",
      riskLevel: parsed.riskLevel || "medium",
      suggestedEntryPrice: entryPrice,
      suggestedStopLoss: action === "HOLD" ? null : stopLoss,
      suggestedTakeProfit: action === "HOLD" ? null : takeProfit,
      expectedMovePercent,
      expectedMoveUsd: (expectedMovePercent / 100) * entryPrice,
      atrPercent: atrPercent ?? undefined,
      divergence: divergenceResult ? {
        bullishCount: divergenceResult.bullishCount,
        bearishCount: divergenceResult.bearishCount,
        overallBias: divergenceResult.overallBias,
      } : null,
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
    if (rows.length === 0) { res.json({}); return; }
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
    }});
  } catch (err) {
    req.log.error({ err }, "Failed to load latest AI signal");
    res.status(500).json({ error: "Failed to load latest AI signal" });
  }
});

router.get("/latest-signals-by-symbol", async (req, res) => {
  try {
    const cfgRows = await db.select().from(botConfigTable).limit(1);
    const cfg = cfgRows[0];
    const watchSet = new Set<string>(
      cfg
        ? (Array.isArray(cfg.watchSymbols) && cfg.watchSymbols.length > 0
            ? (cfg.watchSymbols as string[])
            : [cfg.symbol])
        : []
    );
    const rows = await db.select().from(aiSignalsTable).orderBy(desc(aiSignalsTable.createdAt)).limit(500);
    const seen = new Set<string>();
    const signals: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      if (watchSet.size > 0 && !watchSet.has(r.symbol)) continue;
      if (seen.has(r.symbol)) continue;
      seen.add(r.symbol);
      signals.push({
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
      });
    }
    res.json({ signals });
  } catch (err) {
    req.log.error({ err }, "Failed to load latest AI signals by symbol");
    res.status(500).json({ error: "Failed to load latest AI signals by symbol" });
  }
});

export default router;
