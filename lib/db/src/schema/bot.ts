import { pgTable, text, real, integer, boolean, timestamp, serial, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export interface SymbolOverride {
  tradeAmount?: number | null;
  minConfidence?: number | null;
  takeProfitPercent?: number | null;
  stopLossPercent?: number | null;
}

export const botConfigTable = pgTable("bot_config", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull().default("BTC/USDT"),
  watchSymbols: jsonb("watch_symbols").$type<string[]>().notNull().default(["BTC/USDT"]),
  timeframe: text("timeframe").notNull().default("15m"),
  tradeAmount: real("trade_amount").notNull().default(100),
  maxPositions: integer("max_positions").notNull().default(1),
  stopLossPercent: real("stop_loss_percent").notNull().default(2),
  takeProfitPercent: real("take_profit_percent").notNull().default(5),
  minConfidence: real("min_confidence").notNull().default(0.7),
  enabledIndicators: jsonb("enabled_indicators").notNull().default(["MACD","RSI","Stoch","CCI","MOM","OBV","VWMACD","CMF","MFI"]),
  autoTrade: boolean("auto_trade").notNull().default(false),
  useAiTargets: boolean("use_ai_targets").notNull().default(true),
  checkIntervalSeconds: integer("check_interval_seconds").notNull().default(900),
  maxDailyLossPercent: real("max_daily_loss_percent").notNull().default(3),
  useMtfFilter: boolean("use_mtf_filter").notNull().default(true),
  strictMtf: boolean("strict_mtf").notNull().default(true),
  mtfTimeframes: jsonb("mtf_timeframes").$type<string[]>().notNull().default(["1h","4h"]),
  useFundingRate: boolean("use_funding_rate").notNull().default(true),
  symbolOverrides: jsonb("symbol_overrides").$type<Record<string, SymbolOverride>>().notNull().default({}),
  leverage: integer("leverage").notNull().default(10),
  marginType: text("margin_type").notNull().default("ISOLATED"),
  notifyOnError: boolean("notify_on_error").notNull().default(true),
  useTrailingStop: boolean("use_trailing_stop").notNull().default(false),
  trailingActivatePercent: real("trailing_activate_percent").notNull().default(1.0),
  trailingDistancePercent: real("trailing_distance_percent").notNull().default(0.5),
  usePartialTp: boolean("use_partial_tp").notNull().default(false),
  partialTpPercent: real("partial_tp_percent").notNull().default(50.0),
  entryMode: text("entry_mode").notNull().default("fixed"),
  paperTrading: boolean("paper_trading").notNull().default(true),
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

export const activePositionsTable = pgTable("active_positions", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull().default("long"),
  entryPrice: real("entry_price").notNull(),
  quantity: real("quantity").notNull(),
  takeProfit: real("take_profit").notNull(),
  stopLoss: real("stop_loss").notNull(),
  expectedMovePercent: real("expected_move_percent"),
  aiConfidence: real("ai_confidence"),
  aiReasoning: text("ai_reasoning"),
  triggeredBy: text("triggered_by").notNull().default("bot"),
  highWaterMark: real("high_water_mark"),
  partialTpDone: boolean("partial_tp_done").notNull().default(false),
  openedAt: timestamp("opened_at").defaultNow().notNull(),
}, (table) => ({
  // ✅ Fix #1: (symbol + side) 조합으로 유니크 인덱스 — 같은 심볼에 롱/숏 동시 헤지 포지션 허용
  symbolSideUnique: uniqueIndex("active_positions_symbol_side_unique").on(table.symbol, table.side),
}));

export const insertActivePositionSchema = createInsertSchema(activePositionsTable).omit({ id: true, openedAt: true });
export type InsertActivePosition = z.infer<typeof insertActivePositionSchema>;
export type ActivePosition = typeof activePositionsTable.$inferSelect;

export const aiSignalsTable = pgTable("ai_signals", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull(),
  action: text("action").notNull(),
  confidence: real("confidence").notNull(),
  riskLevel: text("risk_level").notNull().default("medium"),
  currentPrice: real("current_price").notNull(),
  entryPrice: real("entry_price"),
  takeProfit: real("take_profit"),
  stopLoss: real("stop_loss"),
  expectedMovePercent: real("expected_move_percent"),
  expectedMoveUsd: real("expected_move_usd"),
  reasoning: text("reasoning"),
  bullishCount: integer("bullish_count").notNull().default(0),
  bearishCount: integer("bearish_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAiSignalSchema = createInsertSchema(aiSignalsTable).omit({ id: true, createdAt: true });
export type InsertAiSignal = z.infer<typeof insertAiSignalSchema>;
export type AiSignal = typeof aiSignalsTable.$inferSelect;

export const tradeReflectionsTable = pgTable("trade_reflections", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe"),
  side: text("side").notNull(),
  entryPrice: real("entry_price").notNull(),
  exitPrice: real("exit_price").notNull(),
  exitReason: text("exit_reason").notNull(),
  pnl: real("pnl").notNull(),
  pnlPercent: real("pnl_percent").notNull(),
  holdSeconds: integer("hold_seconds").notNull().default(0),
  originalConfidence: real("original_confidence"),
  originalExpectedMovePercent: real("original_expected_move_percent"),
  originalReasoning: text("original_reasoning"),
  bullishCount: integer("bullish_count").notNull().default(0),
  bearishCount: integer("bearish_count").notNull().default(0),
  lessonText: text("lesson_text"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertTradeReflectionSchema = createInsertSchema(tradeReflectionsTable).omit({ id: true, createdAt: true });
export type InsertTradeReflection = z.infer<typeof insertTradeReflectionSchema>;
export type TradeReflection = typeof tradeReflectionsTable.$inferSelect;
