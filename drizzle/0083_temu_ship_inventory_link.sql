-- TEMU 发货单 × 库存联动列（0083）：装箱发货环节接入自建库存体系
--   factory_direct：装箱时勾选「工厂直发」——跳过库存硬阻断、不扣库存
--   source_warehouse_id：发货仓（inventory_warehouse.id，默认主仓可切义乌）
-- 两列均为库存联动本地语义列，官方同步 upsert 不触碰（不在 update 集合内）。
ALTER TABLE "temu_ship_order" ADD COLUMN "factory_direct" boolean;
--> statement-breakpoint
ALTER TABLE "temu_ship_order" ADD COLUMN "source_warehouse_id" uuid;
