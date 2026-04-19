# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Crypto Trader (artifacts/crypto-trader + artifacts/api-server)

AI-powered cryptocurrency automated trading platform built around the user's
"Divergence for Many Indicators v4" Pine Script strategy.

- **Default mode**: 15-minute timeframe, single-position scalping based on multi-indicator
  divergence (MACD, RSI, Stoch, CCI, MOM, OBV, VWMACD, CMF, MFI).
- **AI loop**: when a divergence is detected, GPT predicts the expected price move and
  proposes TP/SL. The bot persists every signal to `ai_signals` and, if `auto_trade` and
  `use_ai_targets` are on, opens a tracked entry in `active_positions`.
- **TP/SL monitoring**: each tick checks all `active_positions` and closes any that have
  hit their take-profit or stop-loss, recording a P&L row in `trade_history`.
- **Safety guardrails**: every AI decision is sanitized server-side (signed move clamped
  to 0.2–6%, TP/SL orientation enforced, min stop distance based on ATR, RR ≥ 1.2). Tick
  loop is single-flight; new entries use a transactional check + unique index on
  `active_positions.symbol` to prevent double entries.
- **Binance**: signed HMAC-SHA256 requests; demo $10k USDT portfolio is forced unless
  `BINANCE_LIVE_MODE=true` is set in production.
- **UI**: Korean-language pages — Dashboard (AI signal + active position cards),
  Chart (15m default + AI signal panel), Bot Control (15m + AI auto TP/SL toggle), Portfolio, Trade.
