-- 今日销量漏统计修复：temu_sales_overview 由「contentHash 去重追加」改为
-- 「每 (店, SKC, 日) 一行、每轮同步覆盖更新」。
-- 根因：官方 API 同步沿用了插件时代的 contentHash 去重——内容未变化的在售
-- 商品不重新落行，而概览按「当日最新批次（captured_at）求和」，批次只含
-- 变化子集导致今日销量大幅低估（实测 123 vs 官方实时 264/卖家中心 263）。

ALTER TABLE "temu_sales_overview" ADD COLUMN IF NOT EXISTS "captured_day" date;
UPDATE "temu_sales_overview"
SET captured_day = (captured_at AT TIME ZONE 'Asia/Shanghai')::date
WHERE captured_day IS NULL;
ALTER TABLE "temu_sales_overview" ALTER COLUMN "captured_day" SET NOT NULL;

-- 同日多行（历史去重口径产物）每键仅保留最新一行
DELETE FROM "temu_sales_overview" o
USING "temu_sales_overview" o2
WHERE o.store_id = o2.store_id
  AND o.skc_id = o2.skc_id
  AND o.captured_day = o2.captured_day
  AND (o.captured_at, o.id) < (o2.captured_at, o2.id);

DROP INDEX IF EXISTS "gt_temu_sales_dedup";
CREATE UNIQUE INDEX "gt_temu_sales_day" ON "temu_sales_overview" (store_id, skc_id, captured_day);
CREATE INDEX IF NOT EXISTS "gt_temu_sales_day_time" ON "temu_sales_overview" (store_id, captured_day);
