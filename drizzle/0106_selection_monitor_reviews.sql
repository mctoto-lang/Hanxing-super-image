-- 0106：选品工具竞品监控 + 评论洞察
--   1. selection_monitor 竞品监控目标表（周期重抓调度单位）
--   2. selection_task.monitor_id 监控任务关联（趋势 = 按 monitor_id 聚合历史结果行）
--   3. selection_review 评论正文表（监控评论抓取 + 社媒评论，供评论洞察/AI 分析）
--   4. selection_ai_summary AI 分析结果（监控目标级 + 社媒平台日汇总级）
-- 说明：task_type 枚举 monitor/review 已在 0104 预置，无需变更。

-- ── 1. 竞品监控目标 ──
CREATE TABLE "selection_monitor" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "platform" varchar(32) NOT NULL,
  "target_url" text NOT NULL,
  "external_id" varchar(255),
  "title" text,
  "image_url" text,
  "country" varchar(16),
  "last_price" numeric(12,2),
  "last_rating" numeric(3,2),
  "last_sales_count" integer,
  "last_review_count" integer,
  "last_likes_count" integer,
  "last_comments_count" integer,
  "last_metrics_at" timestamptz,
  "interval_hours" integer DEFAULT 24 NOT NULL,
  "track_reviews" boolean DEFAULT true NOT NULL,
  "review_max" integer DEFAULT 50 NOT NULL,
  "status" varchar(16) DEFAULT 'active' NOT NULL,
  "pause_reason" varchar(255),
  "last_run_at" timestamptz,
  "next_run_at" timestamptz DEFAULT now() NOT NULL,
  "run_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "sm_ent_target" ON "selection_monitor" ("enterprise_id","target_url");
CREATE INDEX "sm_ent_status_next" ON "selection_monitor" ("enterprise_id","status","next_run_at");

-- ── 2. 任务 ↔ 监控关联 ──
ALTER TABLE "selection_task" ADD COLUMN "monitor_id" uuid REFERENCES "selection_monitor"("id") ON DELETE SET NULL;
CREATE INDEX "st_monitor" ON "selection_task" ("monitor_id");

-- ── 3. 评论正文 ──
CREATE TABLE "selection_review" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "selection_task"("id") ON DELETE CASCADE,
  "monitor_id" uuid REFERENCES "selection_monitor"("id") ON DELETE SET NULL,
  "enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
  "platform" varchar(32) NOT NULL,
  "country" varchar(16),
  "external_id" varchar(255),
  "dedupe_key" text NOT NULL,
  "target_title" text,
  "target_url" text,
  "author_name" varchar(255),
  "rating" numeric(3,2),
  "content" text,
  "likes_count" integer,
  "verified" boolean,
  "published_at" timestamptz,
  "scraped_at" timestamptz DEFAULT now() NOT NULL,
  "raw_data" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "srv_task_dedupe" ON "selection_review" ("task_id","dedupe_key");
CREATE INDEX "srv_ent_platform" ON "selection_review" ("enterprise_id","platform","scraped_at");
CREATE INDEX "srv_monitor" ON "selection_review" ("monitor_id","scraped_at");

-- ── 4. AI 分析结果 ──
--   kind='monitor'：单监控目标评论汇总（每目标一行，重抓后覆盖刷新）
--   kind='digest' ：社媒平台日汇总（enterprise+platform+day 一行，任务完成后覆盖刷新）
CREATE TABLE "selection_ai_summary" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "enterprise_id" uuid NOT NULL REFERENCES "enterprise"("id") ON DELETE CASCADE,
  "kind" varchar(16) NOT NULL,
  "monitor_id" uuid REFERENCES "selection_monitor"("id") ON DELETE CASCADE,
  "day" date,
  "platform" varchar(32),
  "model_name" varchar(255),
  "summary" jsonb NOT NULL,
  "review_count" integer DEFAULT 0 NOT NULL,
  "post_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "sas_monitor" ON "selection_ai_summary" ("monitor_id") WHERE kind = 'monitor' AND monitor_id IS NOT NULL;
CREATE UNIQUE INDEX "sas_digest" ON "selection_ai_summary" ("enterprise_id","platform","day") WHERE kind = 'digest';
