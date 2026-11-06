-- 0088：库存单仓化（义乌仓库存并入主仓，仓库表保留 yiwu 历史行不删）+ 条码 boolean 化
-- 业务上只保留一个仓库：写入侧全部固定主仓（代码层），本迁移收敛历史数据。
-- 无 main 仓企业的义乌库存保留待人工确认（2c 的 DELETE 加目标仓存在性守卫，不删除）。

-- 1) 条码文本 → 预贴标记（已填条码的行回填 true = 无需打印），随后删除文本列
ALTER TABLE inventory_product ADD COLUMN IF NOT EXISTS barcode_pre_pasted boolean NOT NULL DEFAULT false;
UPDATE inventory_product SET barcode_pre_pasted = true WHERE coalesce(barcode, '') <> '' AND NOT barcode_pre_pasted;
ALTER TABLE inventory_product DROP COLUMN IF EXISTS barcode;

-- 2) 义乌仓库存并入主仓（先加已有主仓行，再补缺主仓行的货号，最后清空义乌仓全部库存行；
--    幂等：重跑时义乌仓已无库存行，三段均无操作）
-- 2a) 已有主仓行：累加
UPDATE inventory_stock t
SET qty = t.qty + s.qty, updated_at = now()
FROM inventory_stock s
JOIN inventory_warehouse y ON y.id = s.warehouse_id AND y.code = 'yiwu'
JOIN inventory_warehouse m ON m.enterprise_id = y.enterprise_id AND m.code = 'main'
WHERE t.warehouse_id = m.id AND t.product_id = s.product_id AND s.qty <> 0;

-- 2b) 主仓无行的货号：新插入主仓行
INSERT INTO inventory_stock (id, enterprise_id, product_id, warehouse_id, qty, updated_at)
SELECT gen_random_uuid(), s.enterprise_id, s.product_id, m.id, s.qty, now()
FROM inventory_stock s
JOIN inventory_warehouse y ON y.id = s.warehouse_id AND y.code = 'yiwu'
JOIN inventory_warehouse m ON m.enterprise_id = y.enterprise_id AND m.code = 'main'
WHERE s.qty <> 0
  AND NOT EXISTS (
    SELECT 1 FROM inventory_stock t WHERE t.product_id = s.product_id AND t.warehouse_id = m.id
  );

-- 2c) 清空义乌仓全部库存行（含 qty=0 空行；仅限该企业已有 main 仓，与 2a/2b 口径一致）
DELETE FROM inventory_stock s
USING inventory_warehouse y
WHERE s.warehouse_id = y.id AND y.code = 'yiwu'
  AND EXISTS (
    SELECT 1 FROM inventory_warehouse m
    WHERE m.enterprise_id = y.enterprise_id AND m.code = 'main'
  );
