ALTER TABLE "agent_message" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "pending_action" jsonb;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "selected_direction_id" varchar(40);