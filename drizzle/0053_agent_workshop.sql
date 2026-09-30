-- AI Agent 卡牌工坊重构：固定流水线（三产品线）
-- 1) 产品线配置表（管理员预配置各角色模型与阈值）
CREATE TABLE "agent_direction_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"direction" varchar(20) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sample_enabled" boolean DEFAULT true NOT NULL,
	"sample_count" integer DEFAULT 6 NOT NULL,
	"max_retries" integer DEFAULT 2 NOT NULL,
	"thresholds" jsonb NOT NULL,
	"models" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "adc_direction_unique" ON "agent_direction_config" USING btree ("direction");
--> statement-breakpoint
-- 2) run 扩列：方向 / 阶段 / 风格规范书
ALTER TABLE "agent_run" ADD COLUMN "direction" varchar(20);
--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "phase" varchar(10) DEFAULT 'sample' NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "style_doc" text;
--> statement-breakpoint
-- 3) item 扩列：小样标记
ALTER TABLE "agent_run_item" ADD COLUMN "is_sample" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- 4) 移除自由工作流相关（本功能未发布）
ALTER TABLE "agent_run" DROP CONSTRAINT IF EXISTS "agent_run_workflow_id_agent_workflow_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_run" DROP COLUMN IF EXISTS "workflow_id";
--> statement-breakpoint
ALTER TABLE "agent_run" DROP COLUMN IF EXISTS "workflow_name";
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_workflow";
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_workflow_template";
