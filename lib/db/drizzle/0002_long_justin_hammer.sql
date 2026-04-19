ALTER TABLE "bot_config" ADD COLUMN "max_daily_loss_percent" real DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "use_mtf_filter" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "strict_mtf" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "mtf_timeframes" jsonb DEFAULT '["1h","4h"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "use_funding_rate" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_config" ADD COLUMN "symbol_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;