-- 移除盘点域（0087）：盘点单/盘点明细两表删除（盘点页与盘点差异单打印页随代码下线）。
-- 历史盘点过账流水仍保留在 inventory_movement（type='stocktake'），最近变动/流量统计可见。
DROP TABLE IF EXISTS "inventory_stocktake_item";
--> statement-breakpoint
DROP TABLE IF EXISTS "inventory_stocktake";
--> statement-breakpoint
DROP TYPE IF EXISTS "inventory_stocktake_status";
