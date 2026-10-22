-- 模板化发品（M2）：企业级刊登模板 + 发品记录。
-- 模板三层：锁定层（类目链/属性/规格定义/产地/重量/体积/敏感）+ 默认层（标题/图/申报价/货号，发品可覆盖）。
-- 发品仅能基于模板（企业跨店复用）；属性/规格为实时 attrs.get/parentspec.get/spec.create 口径（见 docs §8.12）。
CREATE TABLE IF NOT EXISTS "temu_publish_template" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
  "name" varchar(100) NOT NULL,
  "status" varchar(16) DEFAULT 'draft' NOT NULL,
  "created_by" uuid,
  "category_chain" jsonb NOT NULL,
  "leaf_category_id" bigint NOT NULL,
  "attributes" jsonb NOT NULL,
  "spec_config" jsonb NOT NULL,
  "defaults" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "gt_temu_pub_tpl_ent" ON "temu_publish_template" ("enterprise_id","status");

CREATE TABLE IF NOT EXISTS "temu_publish_record" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
  "template_id" uuid NOT NULL REFERENCES "temu_publish_template"("id") ON DELETE CASCADE,
  "store_id" uuid NOT NULL REFERENCES "temu_store"("id") ON DELETE CASCADE,
  "user_id" uuid,
  "overrides" jsonb NOT NULL,
  "status" varchar(16) DEFAULT 'pending' NOT NULL,
  "product_id" varchar(32),
  "error_code" integer,
  "error_msg" varchar(1000),
  "request_snapshot" jsonb,
  "response_snapshot" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "gt_temu_pub_rec_ent" ON "temu_publish_record" ("enterprise_id","created_at");
CREATE INDEX IF NOT EXISTS "gt_temu_pub_rec_tpl" ON "temu_publish_record" ("template_id");
