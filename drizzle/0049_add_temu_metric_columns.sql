-- 补齐 0047 快照已引入、但迁移 SQL 遗漏的 6 个列（幂等：本地 dev 经 push 已建列，
-- 生产经 migrate 从未建列，ADD COLUMN IF NOT EXISTS 两边都能安全执行）
ALTER TABLE "temu_store" ADD COLUMN IF NOT EXISTS "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "temu_product_flow" ADD COLUMN IF NOT EXISTS "goods_detail_visitor_num" integer;--> statement-breakpoint
ALTER TABLE "temu_product_ads" ADD COLUMN IF NOT EXISTS "net_order_pay_amt" double precision;--> statement-breakpoint
ALTER TABLE "temu_product_ads" ADD COLUMN IF NOT EXISTS "roas_val" double precision;--> statement-breakpoint
ALTER TABLE "temu_product_ads" ADD COLUMN IF NOT EXISTS "net_transaction_cost" double precision;--> statement-breakpoint
ALTER TABLE "temu_product_ads" ADD COLUMN IF NOT EXISTS "net_goods_num" integer;
