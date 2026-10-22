-- Agent 工坊（/agent 塔罗卡牌工坊）模块整体下线：删除全部 8 张 agent_* 表
-- 与模型表 visible_in_agent 列（"Agent 工坊卡面生图可选"开关），并清理
-- 企业 enabled_modules / 权限组 allowed_pages 中遗留的 "agent" 授权
-- （jsonb 数组按值剔除；幂等，可重复执行）。
-- 保留：generation_task 中 source='agent' 的历史生图日志行与 task_source 枚举值
-- （工作台 Agent 仍在写入）；积分流水在共享 credit_tx 表，不受影响。
DROP TABLE IF EXISTS "agent_message" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "agent_asset" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "agent_event" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "agent_review" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "agent_round" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "agent_run_item" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "agent_run" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "agent_direction_config" CASCADE;--> statement-breakpoint
ALTER TABLE "model" DROP COLUMN IF EXISTS "visible_in_agent";--> statement-breakpoint
UPDATE "enterprise" SET "enabled_modules" = "enabled_modules" - 'agent' WHERE "enabled_modules" @> '["agent"]';--> statement-breakpoint
UPDATE "permission_group" SET "allowed_pages" = "allowed_pages" - 'agent' WHERE "allowed_pages" @> '["agent"]';
