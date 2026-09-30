DROP INDEX "agent_tpl_key_unique";--> statement-breakpoint
ALTER TABLE "agent_workflow_template" ADD CONSTRAINT "agent_tpl_key_unique" UNIQUE("key");