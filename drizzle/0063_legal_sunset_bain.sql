ALTER TABLE "workspace_agent_usage" DROP CONSTRAINT "workspace_agent_usage_workflow_id_workspace_agent_workflow_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_agent_usage" ALTER COLUMN "workflow_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_agent_usage" ADD CONSTRAINT "workspace_agent_usage_workflow_id_workspace_agent_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workspace_agent_workflow"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "waj_status_created" ON "workspace_agent_job" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "waj_processing_started" ON "workspace_agent_job" USING btree ("started_at") WHERE "workspace_agent_job"."status" = 'processing';