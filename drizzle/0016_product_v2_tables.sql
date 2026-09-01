CREATE TABLE "platform_size_spec" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform_key" varchar(30) NOT NULL,
	"label" varchar(100) NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"ratio_label" varchar(30),
	"note" text,
	"applies_to" jsonb DEFAULT '["detail"]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_direction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(60) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" varchar(200),
	"prompt_template" text NOT NULL,
	"applies_to" jsonb DEFAULT '["suite","detail"]'::jsonb NOT NULL,
	"supports_count" boolean DEFAULT false NOT NULL,
	"max_count" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pss_platform" ON "platform_size_spec" USING btree ("platform_key","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "pss_platform_label_unique" ON "platform_size_spec" USING btree ("platform_key","label");--> statement-breakpoint
CREATE UNIQUE INDEX "pd_key_unique" ON "product_direction" USING btree ("key");--> statement-breakpoint
CREATE INDEX "pd_active_sort" ON "product_direction" USING btree ("is_active","sort_order");