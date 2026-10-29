-- 0081: 发货单官方样式字段（商品图/易破损标/自动取消截止）
-- 图与易碎标来自 raw.subPurchaseOrderBasicVO；cancel_deadline = captured_at + 官方剩余毫秒（仅待装箱有值）
-- IF NOT EXISTS + CASE 防御：对齐 0064+ 手写迁移幂等惯例（重放无副作用）；
-- fragileTag 仅认 'true'/'false' 文本，其余（空串/缺失/非规范）落 NULL，与应用层
-- typeof 防御（temu-sync.ts upsertShipOrderRows）同口径，避免强转抛错炸掉整个迁移。
ALTER TABLE "temu_ship_order" ADD COLUMN IF NOT EXISTS "product_skc_picture" text;
ALTER TABLE "temu_ship_order" ADD COLUMN IF NOT EXISTS "fragile_tag" boolean;
ALTER TABLE "temu_ship_order" ADD COLUMN IF NOT EXISTS "cancel_deadline" timestamp with time zone;

UPDATE "temu_ship_order"
SET "product_skc_picture" = raw->'subPurchaseOrderBasicVO'->>'productSkcPicture',
    "fragile_tag" = CASE
      WHEN raw->'subPurchaseOrderBasicVO'->>'fragileTag' IN ('true', 'false')
        THEN (raw->'subPurchaseOrderBasicVO'->>'fragileTag')::boolean
      ELSE NULL
    END,
    "cancel_deadline" = CASE
      WHEN raw->>'deliveryOrderCancelLeftTime' ~ '^\d+$'
        AND (raw->>'deliveryOrderCancelLeftTime')::bigint > 0
      THEN "captured_at" + make_interval(secs => (raw->>'deliveryOrderCancelLeftTime')::numeric / 1000)
      ELSE NULL
    END
WHERE raw IS NOT NULL;
