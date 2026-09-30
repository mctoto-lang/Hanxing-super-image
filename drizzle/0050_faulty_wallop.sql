CREATE TABLE "agent_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"node_key" varchar(60),
	"node_type" varchar(20),
	"action" varchar(12) NOT NULL,
	"status" varchar(8) NOT NULL,
	"detail" text,
	"item_id" uuid,
	"round_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_node_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"node_key" varchar(60) NOT NULL,
	"node_type" varchar(20) NOT NULL,
	"title" varchar(120) NOT NULL,
	"status" varchar(12) DEFAULT 'idle' NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"node_key" varchar(60) NOT NULL,
	"kind" varchar(10) NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_round" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"round_number" integer NOT NULL,
	"prompt" text NOT NULL,
	"prompt_source" varchar(12) DEFAULT 'initial' NOT NULL,
	"image_url" text,
	"generation_meta" jsonb,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_credits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"name" varchar(200),
	"meaning" text,
	"current_prompt" text,
	"prompt_source" varchar(12),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"rounds_used" integer DEFAULT 0 NOT NULL,
	"final_round_id" uuid,
	"fallback_content_warning" boolean DEFAULT false NOT NULL,
	"manual_regen_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid,
	"workflow_name" varchar(120) NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"input" jsonb NOT NULL,
	"graph_snapshot" jsonb NOT NULL,
	"cost_centicredits" integer DEFAULT 0 NOT NULL,
	"image_cost_credits" integer DEFAULT 0 NOT NULL,
	"image_count" integer DEFAULT 0 NOT NULL,
	"llm_call_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_workflow_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(60),
	"name" varchar(100) NOT NULL,
	"description" text,
	"graph" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_workflow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"graph" jsonb NOT NULL,
	"source_template_id" uuid,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enterprise" ALTER COLUMN "enabled_modules" SET DEFAULT '["create","chat","assets","mockup","agent","settings"]'::jsonb;--> statement-breakpoint
ALTER TABLE "agent_event" ADD CONSTRAINT "agent_event_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_node_run" ADD CONSTRAINT "agent_node_run_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review" ADD CONSTRAINT "agent_review_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review" ADD CONSTRAINT "agent_review_item_id_agent_run_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."agent_run_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review" ADD CONSTRAINT "agent_review_round_id_agent_round_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."agent_round"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_round" ADD CONSTRAINT "agent_round_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_round" ADD CONSTRAINT "agent_round_item_id_agent_run_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."agent_run_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_item" ADD CONSTRAINT "agent_run_item_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_item" ADD CONSTRAINT "agent_run_item_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_item" ADD CONSTRAINT "agent_run_item_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_workflow_id_agent_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."agent_workflow"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workflow" ADD CONSTRAINT "agent_workflow_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workflow" ADD CONSTRAINT "agent_workflow_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workflow" ADD CONSTRAINT "agent_workflow_source_template_id_agent_workflow_template_id_fk" FOREIGN KEY ("source_template_id") REFERENCES "public"."agent_workflow_template"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aev_run_created" ON "agent_event" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "anr_run_node_unique" ON "agent_node_run" USING btree ("run_id","node_key");--> statement-breakpoint
CREATE INDEX "anr_run_idx" ON "agent_node_run" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "arev_round_idx" ON "agent_review" USING btree ("round_id");--> statement-breakpoint
CREATE INDEX "arev_run_created" ON "agent_review" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "ard_item_round" ON "agent_round" USING btree ("item_id","round_number");--> statement-breakpoint
CREATE INDEX "ard_run_idx" ON "agent_round" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ari_run_idx" ON "agent_run_item" USING btree ("run_id","index");--> statement-breakpoint
CREATE INDEX "ari_ent_user_status" ON "agent_run_item" USING btree ("enterprise_id","user_id","status");--> statement-breakpoint
CREATE INDEX "ar_ent_user_created" ON "agent_run" USING btree ("enterprise_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "ar_status_created" ON "agent_run" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tpl_key_unique" ON "agent_workflow_template" USING btree ("key") WHERE "agent_workflow_template"."key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "aw_ent_user_updated" ON "agent_workflow" USING btree ("enterprise_id","user_id","updated_at");
--> statement-breakpoint
-- 现有企业全量开通 agent 模块（jsonb 注入去重；新企业走列默认值）
UPDATE "enterprise" SET "enabled_modules" = (
  SELECT COALESCE(jsonb_agg(DISTINCT m), '["agent"]'::jsonb)
  FROM jsonb_array_elements("enabled_modules" || '["agent"]'::jsonb) AS m
);