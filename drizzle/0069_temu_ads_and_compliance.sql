-- 广告实时数据 + 牛皮癣体检（M3/M4 运营扩展）：
-- ① 官方广告报表（bg.glo.searchrec.ad.reports.*）落库：店铺级日表补长尾指标列，
--    新建商品级日表（goods.query 天级行，(店,日,商品) upsert 幂等）；
-- ② temu_product 增加主图牛皮癣体检结果（bg.compliancepicture.get.global）。

ALTER TABLE "temu_ads_daily" ADD COLUMN IF NOT EXISTS "metrics" jsonb;

CREATE TABLE IF NOT EXISTS "temu_ads_product_daily" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL REFERENCES temu_store(id) ON DELETE CASCADE,
  "date" date NOT NULL,
  "product_id" varchar(32) NOT NULL,
  "ad_spend" double precision,
  "impr_cnt" integer,
  "clk_cnt" integer,
  "cart_cnt" integer,
  "order_pay_cnt" integer,
  "order_pay_amt" double precision,
  "goods_num" integer,
  "roas" double precision,
  "acos" double precision,
  "transaction_cost" double precision,
  "metrics" jsonb,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "temu_ads_product_daily_unique" ON "temu_ads_product_daily" (store_id, "date", product_id);
CREATE INDEX IF NOT EXISTS "gt_temu_ads_product_daily_time" ON "temu_ads_product_daily" (store_id, "date");

ALTER TABLE "temu_product" ADD COLUMN IF NOT EXISTS "compliance_spot" boolean;
ALTER TABLE "temu_product" ADD COLUMN IF NOT EXISTS "compliance_spot_at" timestamp with time zone;
