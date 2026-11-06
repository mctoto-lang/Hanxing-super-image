-- 库存管理底座（0082）：11 表 + inventory 模块回填（2026-10-29 v1.2 方案）
-- 域结构：仓库/工厂/商品档案/库存明细(货号×仓)/变动流水/生产单(五态+直发扣量)/
-- 直发记录/盘点单+明细/库存日快照/档案变更日志。口径见 schema/inventory.ts 头注。
-- 回填口径（沿 0080 先例但更宽）：inventory 为全企业通用模块——
--   全部存量企业 enabled_modules append；权限组 allowed_pages 非空的组同步 append
--   （空组 = 企业全集自动继承，无需回填）。逐条 NOT ? 守卫幂等。

CREATE TYPE "inventory_movement_type" AS ENUM (
  'initial', 'production_in', 'factory_direct', 'ship_deduct',
  'manual_in', 'manual_out', 'return_in',
  'transfer_out', 'transfer_in', 'stocktake', 'reversal'
);
--> statement-breakpoint
CREATE TYPE "inventory_production_order_status" AS ENUM (
  'materials_pending', 'producing', 'factory_shipped', 'received', 'finished'
);
--> statement-breakpoint
CREATE TYPE "inventory_direct_ship_dest" AS ENUM ('temu', 'warehouse');
--> statement-breakpoint
CREATE TYPE "inventory_production_state" AS ENUM ('active', 'stopped');
--> statement-breakpoint
CREATE TYPE "inventory_stocktake_status" AS ENUM ('draft', 'posted', 'voided');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_warehouse" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
  "code" varchar(32) NOT NULL,
  "name" varchar(64) NOT NULL,
  "sort" integer DEFAULT 0 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inv_wh_ent_code" ON "inventory_warehouse" ("enterprise_id", "code");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_factory" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
  "code" varchar(32) NOT NULL,
  "name" varchar(64) NOT NULL,
  "note" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inv_factory_ent_code" ON "inventory_factory" ("enterprise_id", "code");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_product" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
  "product_code" varchar(32) NOT NULL,
  "name" varchar(128) NOT NULL,
  "image_url" text,
  "carton_qty" integer,
  "lead_time_days" integer,
  "safety_stock" integer DEFAULT 0 NOT NULL,
  "stock_upper" integer,
  "moq" integer,
  "needs_barcode" boolean DEFAULT false NOT NULL,
  "production_state" "inventory_production_state" DEFAULT 'active' NOT NULL,
  "note" text,
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inv_product_ent_code" ON "inventory_product" ("enterprise_id", "product_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inv_product_ent" ON "inventory_product" ("enterprise_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_stock" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL REFERENCES "inventory_product"("id") ON DELETE CASCADE,
  "warehouse_id" uuid NOT NULL REFERENCES "inventory_warehouse"("id") ON DELETE CASCADE,
  "qty" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inv_stock_product_wh" ON "inventory_stock" ("product_id", "warehouse_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inv_stock_ent" ON "inventory_stock" ("enterprise_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_movement" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL REFERENCES "inventory_product"("id") ON DELETE CASCADE,
  "warehouse_id" uuid NOT NULL REFERENCES "inventory_warehouse"("id") ON DELETE CASCADE,
  "type" "inventory_movement_type" NOT NULL,
  "qty_change" integer NOT NULL,
  "qty_before" integer NOT NULL,
  "qty_after" integer NOT NULL,
  "box_qty" integer,
  "ref_type" varchar(32),
  "ref_id" varchar(64),
  "reason" varchar(255),
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inv_mv_ent_time" ON "inventory_movement" ("enterprise_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inv_mv_product" ON "inventory_movement" ("product_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inv_mv_ref" ON "inventory_movement" ("ref_type", "ref_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_production_order" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL REFERENCES "inventory_product"("id") ON DELETE CASCADE,
  "factory_id" uuid NOT NULL REFERENCES "inventory_factory"("id") ON DELETE RESTRICT,
  "quantity" integer NOT NULL,
  "production_date" date NOT NULL,
  "packaged" boolean DEFAULT true NOT NULL,
  "aux_barcode" boolean DEFAULT false NOT NULL,
  "aux_manual" boolean DEFAULT false NOT NULL,
  "aux_bubble" boolean DEFAULT false NOT NULL,
  "aux_warn" boolean DEFAULT false NOT NULL,
  "expected_date" date,
  "status" "inventory_production_order_status" DEFAULT 'materials_pending' NOT NULL,
  "shipped_qty" integer DEFAULT 0 NOT NULL,
  "direct_qty" integer DEFAULT 0 NOT NULL,
  "factory_box_qty" integer,
  "factory_ship_date" date,
  "note" text,
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inv_po_ent_status" ON "inventory_production_order" ("enterprise_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inv_po_product" ON "inventory_production_order" ("product_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_direct_ship" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
  "order_id" uuid NOT NULL REFERENCES "inventory_production_order"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL REFERENCES "inventory_product"("id") ON DELETE CASCADE,
  "ship_date" date NOT NULL,
  "box_qty" integer,
  "qty" integer NOT NULL,
  "dest_type" "inventory_direct_ship_dest" NOT NULL,
  "warehouse_id" uuid REFERENCES "inventory_warehouse"("id") ON DELETE RESTRICT,
  "temu_ref" varchar(128),
  "note" text,
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inv_ds_order" ON "inventory_direct_ship" ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inv_ds_ent" ON "inventory_direct_ship" ("enterprise_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_stocktake" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
  "warehouse_id" uuid NOT NULL REFERENCES "inventory_warehouse"("id") ON DELETE RESTRICT,
  "status" "inventory_stocktake_status" DEFAULT 'draft' NOT NULL,
  "note" text,
  "posted_at" timestamptz,
  "posted_by" uuid,
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inv_st_ent" ON "inventory_stocktake" ("enterprise_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_stocktake_item" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "stocktake_id" uuid NOT NULL REFERENCES "inventory_stocktake"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL REFERENCES "inventory_product"("id") ON DELETE CASCADE,
  "system_qty" integer NOT NULL,
  "actual_qty" integer,
  "diff_qty" integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inv_sti_unique" ON "inventory_stocktake_item" ("stocktake_id", "product_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_snapshot" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
  "day" date NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "inventory_product"("id") ON DELETE CASCADE,
  "warehouse_id" uuid NOT NULL REFERENCES "inventory_warehouse"("id") ON DELETE CASCADE,
  "qty" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inv_snap_unique" ON "inventory_snapshot" ("day", "product_id", "warehouse_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inv_snap_ent_day" ON "inventory_snapshot" ("enterprise_id", "day");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_product_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL REFERENCES "inventory_product"("id") ON DELETE CASCADE,
  "field" varchar(64) NOT NULL,
  "old_value" text,
  "new_value" text,
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inv_plog_product" ON "inventory_product_log" ("product_id", "created_at");
--> statement-breakpoint
-- 模块回填：全部存量企业（inventory 通用模块，默认开通）
UPDATE "enterprise"
SET "enabled_modules" = "enabled_modules" || '["inventory"]'::jsonb
WHERE NOT ("enabled_modules" ? 'inventory');
--> statement-breakpoint
-- 权限组：allowed_pages 非空的组同步 append（空组=企业全集自动继承）
UPDATE "permission_group"
SET "allowed_pages" = "allowed_pages" || '["inventory"]'::jsonb
WHERE jsonb_array_length("allowed_pages") > 0
  AND NOT ("allowed_pages" ? 'inventory');
