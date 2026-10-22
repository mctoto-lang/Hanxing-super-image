-- API 广告注册表：仅记录通过本站（bg.glo.searchrec.ad.create）创建的广告，
-- 「我的广告」= 本表 + ad.detail.query 实时状态/指标。
-- 平台限制（2026-10-20 实测确认）：卖家后台手动创建的广告对官方接口不可见，
-- 报表/状态均查不到，故注册表是「仅本页创建可同步」口径的载体。
CREATE TABLE IF NOT EXISTS "temu_ad" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL REFERENCES "temu_store"("id") ON DELETE CASCADE,
  "product_id" varchar(32) NOT NULL,
  "budget" integer,
  "roas" double precision,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "gt_temu_ad_dedup" ON "temu_ad" ("store_id","product_id");
