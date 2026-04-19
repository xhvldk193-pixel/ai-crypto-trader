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
