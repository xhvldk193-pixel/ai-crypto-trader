CREATE TABLE "active_positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"side" text DEFAULT 'long' NOT NULL,
	"entry_price" real NOT NULL,
	"quantity" real NOT NULL,
	"take_profit" real NOT NULL,
	"stop_loss" real NOT NULL,
	"expected_move_percent" real,
	"ai_confidence" real,
	"ai_reasoning" text,
	"triggered_by" text DEFAULT 'bot' NOT NULL,
	"opened_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"action" text NOT NULL,
	"confidence" real NOT NULL,
	"risk_level" text DEFAULT 'medium' NOT NULL,
	"current_price" real NOT NULL,
	"entry_price" real,
	"take_profit" real,
	"stop_loss" real,
	"expected_move_percent" real,
	"expected_move_usd" real,
	"reasoning" text,
	"bullish_count" integer DEFAULT 0 NOT NULL,
	"bearish_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text DEFAULT 'BTC/USDT' NOT NULL,
	"timeframe" text DEFAULT '15m' NOT NULL,
	"trade_amount" real DEFAULT 100 NOT NULL,
	"max_positions" integer DEFAULT 1 NOT NULL,
	"stop_loss_percent" real DEFAULT 2 NOT NULL,
	"take_profit_percent" real DEFAULT 5 NOT NULL,
	"min_confidence" real DEFAULT 0.7 NOT NULL,
	"enabled_indicators" jsonb DEFAULT '["MACD","RSI","Stoch","CCI","MOM","OBV","VWMACD","CMF","MFI"]'::jsonb NOT NULL,
	"auto_trade" boolean DEFAULT false NOT NULL,
	"use_ai_targets" boolean DEFAULT true NOT NULL,
	"check_interval_seconds" integer DEFAULT 60 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"symbol" text,
	"action" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"price" real NOT NULL,
	"quantity" real NOT NULL,
	"total" real NOT NULL,
	"fee" real DEFAULT 0 NOT NULL,
	"pnl" real,
	"triggered_by" text DEFAULT 'manual' NOT NULL,
	"exchange_order_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "active_positions_symbol_unique" ON "active_positions" USING btree ("symbol");