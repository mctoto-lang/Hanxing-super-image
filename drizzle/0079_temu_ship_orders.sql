-- TEMU 发货域落库（0079）：发货单 + 包裹明细两表——同步源 api-ship-orders
-- （bg.shiporderv2.get 按 deliverTime 窗口增量）与发货 tab 跟踪/统计的底座。
-- 字段对齐官方响应真实店实证（scripts/temu-probe-ship-fields.ts），raw 列保留
-- 整行快照兜底；库存联动列（源仓/流水引用）留待库存底座批次另行迁移。
CREATE TABLE IF NOT EXISTS "temu_ship_order" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" uuid NOT NULL REFERENCES "temu_store"("id") ON DELETE CASCADE,
  "delivery_order_sn" varchar(64) NOT NULL,
  "sub_purchase_order_sn" varchar(64),
  "product_skc_id" bigint,
  "skc_ext_code" varchar(64),
  "sub_warehouse_id" bigint,
  "sub_warehouse_name" varchar(120),
  "status" integer NOT NULL,
  "urgency_type" integer,
  "is_custom_product" boolean,
  "inventory_region" integer,
  "purchase_stock_type" integer,
  "delivery_method" integer,
  "express_batch_sn" varchar(64),
  "express_company_id" bigint,
  "express_company" varchar(120),
  "express_delivery_sn" varchar(64),
  "delivery_address_id" bigint,
  "receive_address_info" jsonb,
  "deliver_package_num" integer,
  "other_delivery_package_num" integer,
  "predict_total_package_weight" integer,
  "delivery_order_create_time" timestamptz,
  "deliver_time" timestamptz,
  "receive_time" timestamptz,
  "inbound_time" timestamptz,
  "purchase_time" timestamptz,
  "expect_pick_up_goods_time" timestamptz,
  "expect_latest_pick_time" timestamptz,
  "latest_feedback_status" integer,
  "express_weight_feedback_status" integer,
  "express_reject_status" integer,
  "exception_feedback_total_count" integer,
  "receive_skc_num" integer,
  "defective_skc_num" integer,
  "receive_package_num" integer,
  "skc_purchase_num" integer,
  "deliver_skc_num" integer,
  "is_print_box_mark" boolean,
  "supplier_id" bigint,
  "is_cloth_category" boolean,
  "if_can_operate_deliver" boolean,
  "driver_name" varchar(120),
  "plate_number" varchar(32),
  "raw" jsonb,
  "content_hash" varchar(40) NOT NULL,
  "captured_at" timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "gt_temu_ship_order_sn" ON "temu_ship_order" ("store_id", "delivery_order_sn");
CREATE INDEX IF NOT EXISTS "gt_temu_ship_order_time" ON "temu_ship_order" ("store_id", "deliver_time");
CREATE INDEX IF NOT EXISTS "gt_temu_ship_order_status" ON "temu_ship_order" ("store_id", "status");
CREATE INDEX IF NOT EXISTS "gt_temu_ship_order_ext" ON "temu_ship_order" ("store_id", "skc_ext_code");
CREATE INDEX IF NOT EXISTS "gt_temu_ship_order_sub" ON "temu_ship_order" ("store_id", "sub_purchase_order_sn");

CREATE TABLE IF NOT EXISTS "temu_ship_package" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" uuid NOT NULL REFERENCES "temu_store"("id") ON DELETE CASCADE,
  "delivery_order_sn" varchar(64) NOT NULL,
  "package_sn" varchar(64) NOT NULL,
  "skc_num" integer,
  "package_detail" jsonb,
  "receive_time" timestamptz,
  "captured_at" timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "gt_temu_ship_pkg_sn" ON "temu_ship_package" ("store_id", "delivery_order_sn", "package_sn");
