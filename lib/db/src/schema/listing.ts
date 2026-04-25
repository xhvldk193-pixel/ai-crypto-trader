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
  status:         text("status").notNull().default("detected"),
  note:           text("note"),
  entryPrice:     real("entry_price"),
  quantity:       real("quantity"),
  takeProfit:     real("take_profit"),
  stopLoss:       real("stop_loss"),
  isPaper:        boolean("is_paper").default(false),
  maxHoldHours:   integer("max_hold_hours").default(4),
  enteredAt:      timestamp("entered_at"),
  exitPrice:      real("exit_price"),
  exitReason:     text("exit_reason"),
  pnl:            real("pnl"),
  pnlPercent:     real("pnl_percent"),
  closedAt:       timestamp("closed_at"),
});
