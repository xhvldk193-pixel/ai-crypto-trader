import app from "./app";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { activePositionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { exchangeService, syncDemoPositionsFromDb } from "./lib/exchange";
import { listingMonitor } from "./lib/listingMonitor";
import {
  restoreFromDb as restoreListingTrades,
  handleListingEvent,
  startPositionMonitor,
} from "./lib/listingTrader";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required.");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT: "${rawPort}"`);

async function bootstrap() {
  // 데모 포지션 복원
  if (exchangeService.isDemo) {
    try {
      const paperPositions = await db
        .select().from(activePositionsTable)
        .where(eq(activePositionsTable.triggeredBy, "paper"));
      if (paperPositions.length > 0) {
        await syncDemoPositionsFromDb(
          paperPositions.map(p => ({
            symbol: p.symbol, side: p.side,
            entryPrice: p.entryPrice, quantity: p.quantity,
          }))
        );
        logger.info({ count: paperPositions.length }, "Demo positions restored");
      }
    } catch (err) {
      logger.warn({ err }, "Failed to restore demo positions");
    }
  }

  // 상장 트레이드 DB 복원
  await restoreListingTrades();

  // 상장 모니터 → 트레이더 연결
  listingMonitor.onListing(async (event) => {
    await handleListingEvent(event);
  });

  // 환경변수 LISTING_AUTO_START=true 면 서버 시작 시 자동 실행
  if (process.env.LISTING_AUTO_START === "true") {
    listingMonitor.start();
    startPositionMonitor();
    logger.info("상장 모니터 자동 시작 (LISTING_AUTO_START=true)");
  }

  app.listen(port, (err) => {
    if (err) { logger.error({ err }, "Server listen error"); process.exit(1); }
    logger.info({ port }, "Server listening");
  });
}

bootstrap().catch(err => {
  logger.error({ err }, "Bootstrap failed");
  process.exit(1);
});
