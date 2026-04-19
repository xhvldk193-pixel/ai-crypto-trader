import { pgTable, text, real, integer, boolean, timestamp, serial, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const botConfigTable = pgTable("bot_config", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull().default("BTC/USDT"),
  timeframe: text("timeframe").notNull().default("1h"),
  tradeAmount: real("trade_amount").notNull().default(100),
  maxPositions: integer("max_positions").notNull().default(3),
  stopLossPercent: real("stop_loss_percent").notNull().default(2),
  takeProfitPercent: real("take_profit_percent").notNull().default(5),
  minConfidence: real("min_confidence").notNull().default(0.7),
  enabledIndicators: jsonb("enabled_indicators").notNull().default(["MACD","RSI","Stoch","CCI","MOM","OBV","VWMACD","CMF","MFI"]),
  autoTrade: boolean("auto_trade").notNull().default(false),
  checkIntervalSeconds: integer("check_interval_seconds").notNull().default(60),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertBotConfigSchema = createInsertSchema(botConfigTable).omit({ id: true, updatedAt: true });
export type InsertBotConfig = z.infer<typeof insertBotConfigSchema>;
export type BotConfig = typeof botConfigTable.$inferSelect;

export const botLogsTable = pgTable("bot_logs", {
  id: serial("id").primaryKey(),
  level: text("level").notNull().default("info"),
  message: text("message").notNull(),
  symbol: text("symbol"),
  action: text("action"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertBotLogSchema = createInsertSchema(botLogsTable).omit({ id: true, createdAt: true });
export type InsertBotLog = z.infer<typeof insertBotLogSchema>;
export type BotLog = typeof botLogsTable.$inferSelect;

export const tradeHistoryTable = pgTable("trade_history", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  price: real("price").notNull(),
  quantity: real("quantity").notNull(),
  total: real("total").notNull(),
  fee: real("fee").notNull().default(0),
  pnl: real("pnl"),
  triggeredBy: text("triggered_by").notNull().default("manual"),
  exchangeOrderId: text("exchange_order_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertTradeHistorySchema = createInsertSchema(tradeHistoryTable).omit({ id: true, createdAt: true });
export type InsertTradeHistory = z.infer<typeof insertTradeHistorySchema>;
export type TradeHistory = typeof tradeHistoryTable.$inferSelect;
