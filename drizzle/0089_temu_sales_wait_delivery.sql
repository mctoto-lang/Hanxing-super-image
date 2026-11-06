-- 0089：temu_sales_overview 加「待发货库存」列（TEMU 净库存口径的扣减项）
-- 口径：TEMU 净库存 = 仓内库存(warehouse_available_stock) − 待发货库存(wait_delivery_stock)。
--   待发货库存无参考价值（TEMU 自动创建备货单会推高该值），可售天数分子用净库存。
-- 数据源 salesv2 inventoryNumInfo.waitDeliveryInventoryNum（各 SKU 求和，与仓内库存同链路落库）。
-- 历史行保持 NULL（视作 0），自部署后首个同步周期起有值。
ALTER TABLE temu_sales_overview ADD COLUMN IF NOT EXISTS wait_delivery_stock int;
