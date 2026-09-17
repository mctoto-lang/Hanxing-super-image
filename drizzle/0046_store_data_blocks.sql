CREATE TABLE IF NOT EXISTS "temu_discovered_mall" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
	"mall_id" varchar(32) NOT NULL,
	"mall_name" varchar(100),
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "temu_discovered_mall_mall_unique" UNIQUE("enterprise_id","mall_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "temu_ads_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL REFERENCES temu_store("id") ON DELETE CASCADE,
	"date" date NOT NULL,
	"ad_spend" double precision DEFAULT 0 NOT NULL,
	"impressions" integer,
	"clicks" integer,
	"orders" integer,
	"gmv" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "temu_ads_daily_unique" UNIQUE("store_id","date")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gt_temu_ads_daily_time" ON "temu_ads_daily" ("store_id","date");
