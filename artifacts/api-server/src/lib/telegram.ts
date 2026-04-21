import { logger } from "./logger";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID;

export const telegramConfigured = Boolean(BOT_TOKEN && OWNER_CHAT_ID);

if (!telegramConfigured) {
  logger.warn(
    "TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_CHAT_ID not set; Telegram 2FA will fail",
  );
}

export async function sendOwnerMessage(text: string): Promise<void> {
  if (!BOT_TOKEN || !OWNER_CHAT_ID) {
    throw new Error("Telegram is not configured");
  }
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: OWNER_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Telegram sendMessage failed: ${res.status} ${body.slice(0, 200)}`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

const alertDebounceMap = new Map<string, number>();
const ALERT_DEBOUNCE_MS = 5 * 60 * 1000;

export async function notifyAlert(
  level: "error" | "warning" | "info",
  message: string,
  dedupeKey?: string,
): Promise<void> {
  if (!telegramConfigured) return;
  const key = dedupeKey ?? message.slice(0, 80);
  const now = Date.now();
  const last = alertDebounceMap.get(key);
  if (last && now - last < ALERT_DEBOUNCE_MS) return;
  alertDebounceMap.set(key, now);
  const icon = level === "error" ? "🚨" : level === "warning" ? "⚠️" : "ℹ️";
  try {
    await sendOwnerMessage(`${icon} [${level.toUpperCase()}] ${message}`);
  } catch (err) {
    logger.warn({ err }, "Failed to send Telegram alert");
  }
}

/**
 * 진입 시 신호 통계 + 진입 정보를 텔레그램으로 전송.
 * bot.ts의 processSymbol에서 실제 진입 직후 호출.
 */
export async function notifyEntry(params: {
  symbol: string;
  action: "BUY" | "SELL";
  entryPrice: number;
  takeProfit: number;
  stopLoss: number;
  confidence: number;
  expectedMovePercent: number;
  bullishCount: number;
  bearishCount: number;
  signalStats: string;
  isPaper: boolean;
}): Promise<void> {
  if (!telegramConfigured) return;
  const {
    symbol, action, entryPrice, takeProfit, stopLoss,
    confidence, expectedMovePercent, bullishCount, bearishCount,
    signalStats, isPaper,
  } = params;

  const dir = action === "BUY" ? 1 : -1;
  const tpPct = ((takeProfit - entryPrice) / entryPrice * 100 * dir).toFixed(2);
  const slPct = ((entryPrice - stopLoss) / entryPrice * 100 * dir).toFixed(2);
  const actionIcon = action === "BUY" ? "🟢" : "🔴";
  const paperTag = isPaper ? " <b>[가상]</b>" : "";

  const text = [
    `${actionIcon} <b>${action} 진입${paperTag}</b> — ${symbol}`,
    ``,
    `💰 진입가: <b>$${entryPrice.toFixed(2)}</b>`,
    `🎯 TP: $${takeProfit.toFixed(2)} (+${tpPct}%)`,
    `🛡 SL: $${stopLoss.toFixed(2)} (-${slPct}%)`,
    `📈 예상 변동: ${expectedMovePercent >= 0 ? "+" : ""}${expectedMovePercent.toFixed(2)}%`,
    `🤖 AI 신뢰도: ${(confidence * 100).toFixed(0)}%`,
    ``,
    `📊 다이버전스: 강세 ${bullishCount}개 / 약세 ${bearishCount}개`,
    ``,
    `📉 신호 조합 통계 (30일):`,
    signalStats.trim() || "  (데이터 없음)",
  ].join("\n");

  try {
    await sendOwnerMessage(text);
  } catch (err) {
    logger.warn({ err }, "Failed to send entry notification");
  }
}

/**
 * 청산 시 결과를 텔레그램으로 전송.
 * bot.ts의 manageActivePositions에서 TP/SL 청산 직후 호출.
 */
export async function notifyExit(params: {
  symbol: string;
  side: string;
  exitReason: "TP" | "SL";
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPercent: number;
  holdMinutes: number;
  isPaper: boolean;
}): Promise<void> {
  if (!telegramConfigured) return;
  const { symbol, side, exitReason, entryPrice, exitPrice, pnl, pnlPercent, holdMinutes, isPaper } = params;

  const isWin = exitReason === "TP";
  const icon = isWin ? "✅" : "❌";
  const paperTag = isPaper ? " <b>[가상]</b>" : "";
  const pnlSign = pnl >= 0 ? "+" : "";

  const text = [
    `${icon} <b>${exitReason} 청산${paperTag}</b> — ${symbol} ${side.toUpperCase()}`,
    ``,
    `진입가: $${entryPrice.toFixed(2)} → 청산가: $${exitPrice.toFixed(2)}`,
    `손익: <b>${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPercent.toFixed(2)}%)</b>`,
    `보유시간: ${holdMinutes}분`,
  ].join("\n");

  try {
    await sendOwnerMessage(text);
  } catch (err) {
    logger.warn({ err }, "Failed to send exit notification");
  }
}
