-- 商品档案发货状态（0085）：normal=正常发货（该货物正常发出）/ stopped=停止发货
--   （该货物可能有退货或其他规划，不发货）。纯标记列，不参与库存/预警计算；
--   TEMU 装箱发货弹窗对 stopped 货号做二次确认（不硬阻断）。
-- 幂等惯例：DO 块防 duplicate_type（PG 无 CREATE TYPE IF NOT EXISTS），列用 IF NOT EXISTS。
DO $$ BEGIN
  CREATE TYPE "inventory_ship_state" AS ENUM ('normal', 'stopped');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "inventory_product" ADD COLUMN IF NOT EXISTS "ship_state" "inventory_ship_state" DEFAULT 'normal' NOT NULL;
