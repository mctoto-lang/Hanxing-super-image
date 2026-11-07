-- 0092：滞销判定可配（库存企业级设置 inventory_settings 新增两列）
--   stagnant_days：滞销判定天数 N——近 N 天销量 ≤ stagnant_max_qty 判定为「滞销」（默认 30 天）
--   stagnant_max_qty：滞销判定销量上限（件，默认 0；默认组合与旧口径等价＝近 30 天零销量）
--   口径只按销量；无销量数据（未铺货/新品）不判滞销。库存总览页阈值弹窗统一配置。
ALTER TABLE inventory_settings ADD COLUMN IF NOT EXISTS stagnant_days int NOT NULL DEFAULT 30;
--> statement-breakpoint
ALTER TABLE inventory_settings ADD COLUMN IF NOT EXISTS stagnant_max_qty int NOT NULL DEFAULT 0;
