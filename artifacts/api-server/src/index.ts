import app from "./app";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { activePositionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { exchangeService, syncDemoPositionsFromDb } from "./lib/exchange";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ✅ Fix #7: 서버 시작 시 DB의 paper 포지션을 데모 메모리로 복원
async function bootstrap() {
  if (exchangeService.isDemo) {
    try {
      const paperPositions = await db
        .select()
        .from(activePositionsTable)
        .where(eq(activePositionsTable.triggeredBy, "paper"));
      if (paperPositions.length > 0) {
        await syncDemoPositionsFromDb(
          paperPositions.map((p) => ({
            symbol: p.symbol,
            side: p.side,
            entryPrice: p.entryPrice,
            quantity: p.quantity,
          }))
        );
        logger.info({ count: paperPositions.length }, "Demo positions restored from DB");
      }
    } catch (err) {
      logger.warn({ err }, "Failed to restore demo positions from DB on startup");
    }
  }

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
  });
}

bootstrap().catch((err) => {
  logger.error({ err }, "Bootstrap failed");
  process.exit(1);
});
