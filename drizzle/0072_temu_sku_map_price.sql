-- SKU 级申报价：官方 salesv2 的 SKU 明细 supplierPrice 实测已不再返回
-- （2026-10-20 全量 null），价格权威源 price.list.get 本就按 SKU 查价——
-- temu_sku_map 加列落 SKU 级价格，展开行 SKU 子表显示真实价格。
ALTER TABLE "temu_sku_map" ADD COLUMN IF NOT EXISTS "supplier_price" bigint;
