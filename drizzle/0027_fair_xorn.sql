ALTER TYPE "public"."task_source" ADD VALUE IF NOT EXISTS 'weartry';--> statement-breakpoint
ALTER TYPE "public"."task_type" ADD VALUE IF NOT EXISTS 'weartry';--> statement-breakpoint
CREATE TABLE "weartry_scene" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(60) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" varchar(200),
	"cover_url" text,
	"prompt_template" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "visible_in_weartry" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ws_key_unique" ON "weartry_scene" USING btree ("key");--> statement-breakpoint
CREATE INDEX "ws_active_sort" ON "weartry_scene" USING btree ("is_active","sort_order");--> statement-breakpoint

-- 回填：已开通「商品图片」模块的企业/权限组同步开通「穿戴图片」（未开通的不动，由超管按需开启）
UPDATE "enterprise"
SET "enabled_modules" = "enabled_modules" || '["weartry"]'::jsonb
WHERE "enabled_modules" @> '["product"]'::jsonb
  AND NOT "enabled_modules" ? 'weartry';--> statement-breakpoint

UPDATE "permission_group"
SET "allowed_pages" = "allowed_pages" || '["weartry"]'::jsonb
WHERE "allowed_pages" @> '["product"]'::jsonb
  AND NOT "allowed_pages" ? 'weartry';