CREATE TABLE "temu_product_ads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"goods_id" varchar(32),
	"skc_id" varchar(32),
	"product_sn" varchar(64),
	"product_name" text,
	"captured_at" timestamp with time zone NOT NULL,
	"spend" double precision,
	"impressions" integer,
	"clicks" integer,
	"orders" integer,
	"gmv" double precision,
	"metrics" jsonb,
	"mall_meta" jsonb,
	"content_hash" varchar(40) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "temu_product" ADD COLUMN "lifecycle_status" varchar(64);--> statement-breakpoint
ALTER TABLE "temu_product" ADD COLUMN "site_code" varchar(32);--> statement-breakpoint
ALTER TABLE "temu_product" ADD COLUMN "site_name" varchar(64);--> statement-breakpoint
ALTER TABLE "temu_sales_overview" ADD COLUMN "product_sn" varchar(64);--> statement-breakpoint
ALTER TABLE "temu_sales_overview" ADD COLUMN "today_sales_volume" integer;--> statement-breakpoint
ALTER TABLE "temu_sales_overview" ADD COLUMN "last7_days_sales_volume" integer;--> statement-breakpoint
ALTER TABLE "temu_sales_overview" ADD COLUMN "last30_days_sales_volume" integer;--> statement-breakpoint
ALTER TABLE "temu_sales_overview" ADD COLUMN "warehouse_available_stock" integer;--> statement-breakpoint
ALTER TABLE "temu_sales_overview" ADD COLUMN "shipped_stock" integer;--> statement-breakpoint
ALTER TABLE "temu_product_ads" ADD CONSTRAINT "temu_product_ads_store_id_temu_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."temu_store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gt_temu_ads_dedup" ON "temu_product_ads" USING btree ("store_id","content_hash");--> statement-breakpoint
CREATE INDEX "gt_temu_ads_time" ON "temu_product_ads" USING btree ("store_id","captured_at");--> statement-breakpoint
CREATE INDEX "gt_temu_ads_goods" ON "temu_product_ads" USING btree ("store_id","goods_id");