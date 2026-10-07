ALTER TYPE "public"."api_format" ADD VALUE 'grsai';--> statement-breakpoint
ALTER TYPE "public"."task_source" ADD VALUE IF NOT EXISTS 'agent';--> statement-breakpoint
DROP TABLE "agent_node_run" CASCADE;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "visible_in_agent" boolean DEFAULT false NOT NULL;