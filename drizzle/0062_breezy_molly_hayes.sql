ALTER TABLE "prompt_card" ADD COLUMN "is_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "prompt_card" ADD COLUMN "agent_kind" varchar(12);--> statement-breakpoint
ALTER TABLE "workspace_task" ADD COLUMN "source" varchar(12) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "prompt_card" ADD CONSTRAINT "prompt_card_agent_kind_chk" CHECK ("prompt_card"."agent_kind" IS NULL OR "prompt_card"."agent_kind" IN ('face', 'back', 'box', 'border'));--> statement-breakpoint
ALTER TABLE "workspace_task" ADD CONSTRAINT "workspace_task_source_chk" CHECK ("workspace_task"."source" IN ('manual', 'agent'));