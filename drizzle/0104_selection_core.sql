-- 0104：选品工具核心表（基于 Apify 抓取）。
--   selection_provider（企业级 Apify 凭证，每企业一行，token 加密；未配置回退
--   平台级 APIFY_API_TOKEN）+ selection_task（抓取任务，状态机 queued/processing/
--   completed/failed/cancelled，提交时单事务预扣个人配额积分，结算按实际条数退差额，
--   country/provider_id 为提交时快照）+ selection_result（每任务不可变快照行，
--   raw_data 永久保留，unique(task_id,dedupe_key) 保证 worker 重入幂等；
--   country/task_type 从任务传播，供数据池筛选与卡片渲染）+
--   selection_bookmark（我的选品收藏，collectionName 字符串分组）。
--   credit_tx_type 新增 selection_deduct/selection_refund 两枚举值——本迁移只 ADD VALUE
--   不引用新值（全新库单事务链里同事务新增枚举值不可引用，见 0102 注释），
--   仅运行时由应用代码写入。
DO $$ BEGIN
  CREATE TYPE "public"."selection_task_type" AS ENUM ('discover', 'market', 'monitor', 'review');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."selection_task_status" AS ENUM ('queued', 'processing', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TYPE "public"."credit_tx_type" ADD VALUE IF NOT EXISTS 'selection_deduct';--> statement-breakpoint
ALTER TYPE "public"."credit_tx_type" ADD VALUE IF NOT EXISTS 'selection_refund';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "selection_provider" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
  "name" varchar(100) NOT NULL,
  "token_encrypted" text DEFAULT '' NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "selection_provider_enterprise_id_unique" ON "selection_provider" ("enterprise_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sp_ent_enabled" ON "selection_provider" ("enterprise_id","enabled");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "selection_task" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "task_type" "selection_task_type" DEFAULT 'market' NOT NULL,
  "platform" varchar(32) NOT NULL,
  "actor_id" varchar(255) NOT NULL,
  "search_params" jsonb NOT NULL,
  "keyword" varchar(255),
  "country" varchar(16),
  "provider_id" uuid REFERENCES "selection_provider"("id") ON DELETE SET NULL,
  "max_results" integer NOT NULL,
  "estimated_credits" integer NOT NULL,
  "actual_credits" integer,
  "status" "selection_task_status" DEFAULT 'queued' NOT NULL,
  "progress" integer DEFAULT 0 NOT NULL,
  "fetched_count" integer DEFAULT 0 NOT NULL,
  "apify_run_id" varchar(64),
  "apify_dataset_id" varchar(64),
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "st_ent_status" ON "selection_task" ("enterprise_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "st_ent_created" ON "selection_task" ("enterprise_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "st_apify_run" ON "selection_task" ("apify_run_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "selection_result" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "selection_task"("id") ON DELETE CASCADE,
  "enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
  "platform" varchar(32) NOT NULL,
  "country" varchar(16),
  "task_type" varchar(16),
  "external_id" varchar(255),
  "source_url" text,
  "dedupe_key" text NOT NULL,
  "title" text,
  "content" text,
  "price" numeric(12, 2),
  "original_price" numeric(12, 2),
  "currency" varchar(8),
  "rating" numeric(3, 2),
  "review_count" integer,
  "sales_count" integer,
  "likes_count" integer,
  "comments_count" integer,
  "shares_count" integer,
  "views_count" integer,
  "seller_name" varchar(255),
  "images" jsonb,
  "videos" jsonb,
  "category" varchar(255),
  "category_path" jsonb,
  "tags" jsonb,
  "hashtags" jsonb,
  "published_at" timestamp with time zone,
  "raw_data" jsonb NOT NULL,
  "ai_analysis" jsonb,
  "scraped_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sr_task" ON "selection_result" ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sr_ent_created" ON "selection_result" ("enterprise_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sr_ent_platform" ON "selection_result" ("enterprise_id","platform","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sr_platform_external" ON "selection_result" ("platform","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sr_task_dedupe" ON "selection_result" ("task_id","dedupe_key");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "selection_bookmark" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "result_id" uuid NOT NULL REFERENCES "selection_result"("id") ON DELETE CASCADE,
  "notes" text,
  "custom_tags" jsonb,
  "collection_name" varchar(100),
  "priority" varchar(16),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sb_user_result" ON "selection_bookmark" ("user_id","result_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sb_user_created" ON "selection_bookmark" ("user_id","created_at");
