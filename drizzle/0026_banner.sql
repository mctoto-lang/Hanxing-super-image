CREATE TABLE "banner" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(100) NOT NULL,
	"content" varchar(300) NOT NULL,
	"link_url" text,
	"link_label" varchar(50) DEFAULT '立即查看' NOT NULL,
	"icon" varchar(50) DEFAULT 'megaphone' NOT NULL,
	"countdown_ends_at" timestamp with time zone,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enterprise" ALTER COLUMN "enabled_modules" SET DEFAULT '["create","chat","assets","mockup","settings"]'::jsonb;--> statement-breakpoint
ALTER TABLE "product_direction" ALTER COLUMN "applies_to" SET DEFAULT '["suite"]'::jsonb;--> statement-breakpoint
CREATE INDEX "banner_active" ON "banner" USING btree ("is_active","sort_order");