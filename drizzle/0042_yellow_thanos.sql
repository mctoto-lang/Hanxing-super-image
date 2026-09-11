CREATE TABLE "temu_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"source" varchar(64) NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"payload" jsonb,
	"mall_meta" jsonb,
	"content_hash" varchar(40) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "temu_ingest_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"source" varchar(64) NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"accepted_count" integer DEFAULT 0 NOT NULL,
	"detail" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "temu_metric_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"source" varchar(64) NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"sale_volume" integer,
	"seven_days_sale_volume" integer,
	"thirty_days_sale_volume" integer,
	"on_sale_product_number" integer,
	"wait_product_number" integer,
	"lack_skc_number" integer,
	"about_to_sell_out_number" integer,
	"already_sold_out_number" integer,
	"adjust_price" integer,
	"review_adjust_price" integer,
	"high_price_limit_number" integer,
	"advice_prepare_skc_number" integer,
	"today_sell_out_num" integer,
	"today_sell_out_ratio" double precision,
	"today_soon_sell_out_num" integer,
	"today_soon_sell_out_ratio" double precision,
	"today_sell_out_loss_num" integer,
	"increase_sell_out_num" integer,
	"increase_soon_sell_out_num" integer,
	"metrics" jsonb,
	"mall_meta" jsonb,
	"content_hash" varchar(40) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "temu_product_flow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"goods_id" varchar(32) NOT NULL,
	"goods_name" text,
	"category" varchar(120),
	"source" varchar(64) NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"metrics" jsonb,
	"mall_meta" jsonb,
	"content_hash" varchar(40) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "temu_product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_skc_id" varchar(32) NOT NULL,
	"product_id" varchar(32),
	"goods_id" varchar(32),
	"product_name" text,
	"category" varchar(120),
	"leaf_category_name" varchar(120),
	"supplier_id" varchar(32),
	"supplier_price" bigint,
	"flow_grow_status" integer,
	"has_skc_selected" boolean,
	"remove_status" integer,
	"lifecycle_detail" jsonb,
	"mall_meta" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "temu_sales_overview" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"skc_id" varchar(32) NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"product_name" text,
	"category" varchar(120),
	"supplier_id" varchar(32),
	"price_detail" jsonb,
	"overview" jsonb,
	"mall_meta" jsonb,
	"content_hash" varchar(40) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "temu_store" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"device_token" varchar(64) NOT NULL,
	"mall_id" varchar(32),
	"mall_name" varchar(100),
	"enabled" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "temu_activity" ADD CONSTRAINT "temu_activity_store_id_temu_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."temu_store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temu_ingest_log" ADD CONSTRAINT "temu_ingest_log_store_id_temu_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."temu_store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temu_metric_snapshot" ADD CONSTRAINT "temu_metric_snapshot_store_id_temu_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."temu_store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temu_product_flow" ADD CONSTRAINT "temu_product_flow_store_id_temu_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."temu_store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temu_product" ADD CONSTRAINT "temu_product_store_id_temu_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."temu_store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temu_sales_overview" ADD CONSTRAINT "temu_sales_overview_store_id_temu_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."temu_store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temu_store" ADD CONSTRAINT "temu_store_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gt_temu_act_dedup" ON "temu_activity" USING btree ("store_id","source","content_hash");--> statement-breakpoint
CREATE INDEX "gt_temu_act_time" ON "temu_activity" USING btree ("store_id","source","captured_at");--> statement-breakpoint
CREATE INDEX "gt_temu_log_time" ON "temu_ingest_log" USING btree ("store_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gt_temu_metric_dedup" ON "temu_metric_snapshot" USING btree ("store_id","source","content_hash");--> statement-breakpoint
CREATE INDEX "gt_temu_metric_time" ON "temu_metric_snapshot" USING btree ("store_id","source","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gt_temu_flow_dedup" ON "temu_product_flow" USING btree ("store_id","goods_id","source","content_hash");--> statement-breakpoint
CREATE INDEX "gt_temu_flow_time" ON "temu_product_flow" USING btree ("store_id","source","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gt_temu_product_skc" ON "temu_product" USING btree ("store_id","product_skc_id");--> statement-breakpoint
CREATE INDEX "gt_temu_product_name" ON "temu_product" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gt_temu_sales_dedup" ON "temu_sales_overview" USING btree ("store_id","skc_id","content_hash");--> statement-breakpoint
CREATE INDEX "gt_temu_sales_time" ON "temu_sales_overview" USING btree ("store_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gt_temu_store_token" ON "temu_store" USING btree ("device_token");--> statement-breakpoint
CREATE INDEX "gt_temu_store_ent" ON "temu_store" USING btree ("enterprise_id");