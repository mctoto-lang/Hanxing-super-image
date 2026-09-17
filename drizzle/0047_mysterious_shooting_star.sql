CREATE TABLE "temu_sku_map" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"sku_id" varchar(32) NOT NULL,
	"skc_id" varchar(32) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "temu_sku_sales_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"sku_id" varchar(32) NOT NULL,
	"date" date NOT NULL,
	"sales_number" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "temu_sku_map" ADD CONSTRAINT "temu_sku_map_store_id_temu_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."temu_store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temu_sku_sales_daily" ADD CONSTRAINT "temu_sku_sales_daily_store_id_temu_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."temu_store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gt_temu_sku_map_dedup" ON "temu_sku_map" USING btree ("store_id","sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gt_temu_sku_sales_daily_dedup" ON "temu_sku_sales_daily" USING btree ("store_id","sku_id","date");--> statement-breakpoint
CREATE INDEX "gt_temu_sku_sales_daily_time" ON "temu_sku_sales_daily" USING btree ("store_id","date");
