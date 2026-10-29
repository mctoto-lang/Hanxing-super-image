-- 0081: 发货单官方样式字段（商品图/易破损标/自动取消截止）
-- 图与易碎标来自 raw.subPurchaseOrderBasicVO；cancel_deadline = captured_at + 官方剩余毫秒（仅待装箱有值）
ALTER TABLE "temu_ship_order" ADD COLUMN "product_skc_picture" text;
ALTER TABLE "temu_ship_order" ADD COLUMN "fragile_tag" boolean;
ALTER TABLE "temu_ship_order" ADD COLUMN "cancel_deadline" timestamp with time zone;

UPDATE "temu_ship_order"
SET "product_skc_picture" = raw->'subPurchaseOrderBasicVO'->>'productSkcPicture',
    "fragile_tag" = (raw->'subPurchaseOrderBasicVO'->>'fragileTag')::boolean,
    "cancel_deadline" = CASE
      WHEN raw->>'deliveryOrderCancelLeftTime' ~ '^\d+$'
        AND (raw->>'deliveryOrderCancelLeftTime')::bigint > 0
      THEN "captured_at" + make_interval(secs => (raw->>'deliveryOrderCancelLeftTime')::numeric / 1000)
      ELSE NULL
    END
WHERE raw IS NOT NULL;
