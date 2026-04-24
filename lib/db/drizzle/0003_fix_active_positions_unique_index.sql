-- ✅ Fix #1: active_positions 유니크 인덱스를 symbol 단독 → (symbol, side) 복합으로 변경
-- 이전 인덱스는 같은 심볼에 롱/숏 헤지 포지션을 동시에 열 수 없게 막았음
DROP INDEX IF EXISTS "active_positions_symbol_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "active_positions_symbol_side_unique" ON "active_positions" ("symbol","side");