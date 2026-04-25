// lib/db/src/schema/listing.ts
// lib/db/src/schema/index.ts 에서 export 추가 필요:
// export * from "./listing";

import {
  pgTable, serial, text, real, boolean,
  integer, timestamp,
} from "drizzle-orm/pg-core";

export const listingEventsTable = pgTable("listing_events", {
  id:             serial("id").primaryKey(),
  symbol:         text("symbol").notNull(),
  baseAsset:      text("base_asset").notNull(),
  sourceExchange: text("source_exchange").notNull(),
  title:          text("title").notNull(),
  sourceUrl:      text("source_url").notNull().unique(),
  detectedAt:     timestamp("detected_at").notNull().defaultNow(),

  // detected | processing | entered | closed | skipped | failed
  status:         text("status").notNull().default("detected"),
  note:           text("note"),

  // 진입 정보
  entryPrice:     real("entry_price"),
  quantity:       real("quantity"),
  takeProfit:     real("take_profit"),
  stopLoss:       real("stop_loss"),
  isPaper:        boolean("is_paper").default(false),
  maxHoldHours:   integer("max_hold_hours").default(4),
  enteredAt:      timestamp("entered_at"),

  // 청산 정보
  exitPrice:      real("exit_price"),
  exitReason:     text("exit_reason"),   // TP | SL | TIME
  pnl:            real("pnl"),
  pnlPercent:     real("pnl_percent"),
  closedAt:       timestamp("closed_at"),
});
