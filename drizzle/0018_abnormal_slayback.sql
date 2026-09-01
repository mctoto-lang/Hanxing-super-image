CREATE TABLE "product_language" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(20) NOT NULL,
	"label" varchar(100) NOT NULL,
	"output_name" varchar(100) NOT NULL,
	"image_directive" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_model_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"virtual_name" varchar(200) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_platform" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(30) NOT NULL,
	"label" varchar(100) NOT NULL,
	"hero_prompt_segment" text,
	"general_prompt_segment" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_prompt_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scene" varchar(60) NOT NULL,
	"name" varchar(100) NOT NULL,
	"template" text NOT NULL,
	"note" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_ratio_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"size_value" varchar(30) NOT NULL,
	"label" varchar(100) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_model_alias" ADD CONSTRAINT "product_model_alias_model_id_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plg_key_unique" ON "product_language" USING btree ("key");--> statement-breakpoint
CREATE INDEX "plg_active_sort" ON "product_language" USING btree ("is_active","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "pma_model_unique" ON "product_model_alias" USING btree ("model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pp_key_unique" ON "product_platform" USING btree ("key");--> statement-breakpoint
CREATE INDEX "pp_active_sort" ON "product_platform" USING btree ("is_active","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "ppt_scene_unique" ON "product_prompt_template" USING btree ("scene");--> statement-breakpoint
CREATE UNIQUE INDEX "pra_size_unique" ON "product_ratio_alias" USING btree ("size_value");