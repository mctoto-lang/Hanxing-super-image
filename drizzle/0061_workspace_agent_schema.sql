-- 工作台 Agent 域（/workspace 内嵌 AI Agent）：10 张新表，纯增量，
-- 不触碰任何既有表/枚举（workspace_task 状态枚举保持原样；生图归属沿用
-- task_source 既有 'agent' 值 + generation_task 外键回链，不改共享枚举）。
-- 留痕结构对齐 /agent 卡牌工坊（workflow → direction → card → round →
-- review + event 时间线）并适配工作台多租户体系：
--   workspace_agent_workflow  工作流实例（输入/状态/成本累计）
--   workspace_agent_direction 候选创作方向（用户选定后定稿 style_doc）
--   workspace_agent_card      单卡（kind 卡类 face/back/box/border，产品确认
--                              四类交付用途 + is_locked 终版保护，locked_chk
--                              限制仅可锁已有产出物的卡）
--   workspace_agent_preview   预览图（风格小样/方向示例/单卡试生图；不落 card_image）
--   workspace_agent_round     每轮生成尝试（选中图回链 card_image）
--   workspace_agent_review    审核与裁决记录（result jsonb）
--   workspace_agent_oracle_copy 神谕卡文案（每卡每语言一行，中英双语）
--   workspace_agent_usage     用量账本（LLM 厘/生图积分；业务行删除不连坐账本）
--   workspace_agent_event     事件时间线（看板实时日志）
--   workspace_agent_job       异步任务队列（重试/指数退避，对齐 chat_task；
--                              card_kind 声明批次卡类，四类管线禁止混类批次，
--                              混类拦截在应用层校验后入队）
CREATE TABLE "workspace_agent_card" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"direction_id" uuid,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"card_index" integer NOT NULL,
	"kind" varchar(16) DEFAULT 'face' NOT NULL,
	"name" varchar(200),
	"meaning" text,
	"visual_brief" text,
	"current_prompt" text,
	"prompt_source" varchar(12),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"is_sample" boolean DEFAULT false NOT NULL,
	"rounds_used" integer DEFAULT 0 NOT NULL,
	"final_round_id" uuid,
	"fallback_content_warning" boolean DEFAULT false NOT NULL,
	"manual_regen_count" integer DEFAULT 0 NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"prompt_card_id" uuid,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_agent_card_status_chk" CHECK ("workspace_agent_card"."status" IN ('pending', 'drafting', 'generating', 'reviewing', 'waiting_human', 'approved_by_ai', 'fallback', 'confirmed', 'failed', 'cancelled')),
	CONSTRAINT "workspace_agent_card_kind_chk" CHECK ("workspace_agent_card"."kind" IN ('face', 'back', 'box', 'border')),
	CONSTRAINT "workspace_agent_card_locked_chk" CHECK (NOT "workspace_agent_card"."is_locked" OR "workspace_agent_card"."status" IN ('approved_by_ai', 'fallback', 'confirmed'))
);
--> statement-breakpoint
CREATE TABLE "workspace_agent_direction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"concept" text,
	"worldview" text,
	"palette" text,
	"visual_language" text,
	"style_phrase" varchar(200),
	"sample_cards" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"example_image_url" text,
	"status" varchar(12) DEFAULT 'candidate' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_agent_direction_status_chk" CHECK ("workspace_agent_direction"."status" IN ('candidate', 'selected', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "workspace_agent_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"node_key" varchar(60),
	"action" varchar(12) NOT NULL,
	"status" varchar(8) NOT NULL,
	"detail" text,
	"card_id" uuid,
	"round_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_agent_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"card_kind" varchar(16),
	"job_type" varchar(30) NOT NULL,
	"status" varchar(12) DEFAULT 'queued' NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"retry_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "workspace_agent_job_status_chk" CHECK ("workspace_agent_job"."status" IN ('queued', 'processing', 'completed', 'failed')),
	CONSTRAINT "workspace_agent_job_card_kind_chk" CHECK ("workspace_agent_job"."card_kind" IS NULL OR "workspace_agent_job"."card_kind" IN ('face', 'back', 'box', 'border'))
);
--> statement-breakpoint
CREATE TABLE "workspace_agent_oracle_copy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"locale" varchar(5) DEFAULT 'zh' NOT NULL,
	"headline" varchar(200),
	"keyword" varchar(100),
	"message" text,
	"question" text,
	"status" varchar(12) DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_agent_oracle_copy_locale_chk" CHECK ("workspace_agent_oracle_copy"."locale" IN ('zh', 'en')),
	CONSTRAINT "workspace_agent_oracle_copy_status_chk" CHECK ("workspace_agent_oracle_copy"."status" IN ('draft', 'confirmed', 'outdated'))
);
--> statement-breakpoint
CREATE TABLE "workspace_agent_preview" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"direction_id" uuid,
	"card_id" uuid,
	"enterprise_id" uuid NOT NULL,
	"kind" varchar(12) NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"image_url" text,
	"generation_task_id" uuid,
	"generation_prompt" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_agent_preview_kind_chk" CHECK ("workspace_agent_preview"."kind" IN ('style', 'direction', 'card')),
	CONSTRAINT "workspace_agent_preview_status_chk" CHECK ("workspace_agent_preview"."status" IN ('pending', 'generating', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "workspace_agent_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"node_key" varchar(60) NOT NULL,
	"kind" varchar(10) NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_agent_review_kind_chk" CHECK ("workspace_agent_review"."kind" IN ('review', 'verdict'))
);
--> statement-breakpoint
CREATE TABLE "workspace_agent_round" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"round_number" integer NOT NULL,
	"prompt" text NOT NULL,
	"prompt_source" varchar(12) DEFAULT 'initial' NOT NULL,
	"image_url" text,
	"selected_card_image_id" uuid,
	"generation_task_id" uuid,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_credits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_agent_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid,
	"kind" varchar(10) NOT NULL,
	"node_key" varchar(60),
	"chat_api_id" uuid,
	"image_model_id" uuid,
	"card_id" uuid,
	"round_id" uuid,
	"card_image_id" uuid,
	"generation_task_id" uuid,
	"input_tokens" integer,
	"output_tokens" integer,
	"image_count" integer,
	"cost_centicredits" integer,
	"cost_credits" integer,
	"status" varchar(12) DEFAULT 'success' NOT NULL,
	"error_message" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_agent_usage_kind_chk" CHECK ("workspace_agent_usage"."kind" IN ('llm', 'image')),
	CONSTRAINT "workspace_agent_usage_status_chk" CHECK ("workspace_agent_usage"."status" IN ('success', 'failure', 'timeout'))
);
--> statement-breakpoint
CREATE TABLE "workspace_agent_workflow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_task_id" uuid,
	"title" varchar(120),
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"input" jsonb NOT NULL,
	"style_doc" text,
	"selected_direction_id" uuid,
	"cost_centicredits" integer DEFAULT 0 NOT NULL,
	"unbilled_centicredits" integer DEFAULT 0 NOT NULL,
	"image_cost_credits" integer DEFAULT 0 NOT NULL,
	"image_count" integer DEFAULT 0 NOT NULL,
	"llm_call_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_agent_workflow_status_chk" CHECK ("workspace_agent_workflow"."status" IN ('queued', 'running', 'waiting_human', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "workspace_agent_card" ADD CONSTRAINT "workspace_agent_card_workflow_id_workspace_agent_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workspace_agent_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_card" ADD CONSTRAINT "workspace_agent_card_direction_id_workspace_agent_direction_id_fk" FOREIGN KEY ("direction_id") REFERENCES "public"."workspace_agent_direction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_card" ADD CONSTRAINT "workspace_agent_card_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_card" ADD CONSTRAINT "workspace_agent_card_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_card" ADD CONSTRAINT "workspace_agent_card_prompt_card_id_prompt_card_id_fk" FOREIGN KEY ("prompt_card_id") REFERENCES "public"."prompt_card"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_direction" ADD CONSTRAINT "workspace_agent_direction_workflow_id_workspace_agent_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workspace_agent_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_direction" ADD CONSTRAINT "workspace_agent_direction_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_event" ADD CONSTRAINT "workspace_agent_event_workflow_id_workspace_agent_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workspace_agent_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_event" ADD CONSTRAINT "workspace_agent_event_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_job" ADD CONSTRAINT "workspace_agent_job_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_job" ADD CONSTRAINT "workspace_agent_job_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_job" ADD CONSTRAINT "workspace_agent_job_workflow_id_workspace_agent_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workspace_agent_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_oracle_copy" ADD CONSTRAINT "workspace_agent_oracle_copy_workflow_id_workspace_agent_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workspace_agent_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_oracle_copy" ADD CONSTRAINT "workspace_agent_oracle_copy_card_id_workspace_agent_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."workspace_agent_card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_oracle_copy" ADD CONSTRAINT "workspace_agent_oracle_copy_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_preview" ADD CONSTRAINT "workspace_agent_preview_workflow_id_workspace_agent_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workspace_agent_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_preview" ADD CONSTRAINT "workspace_agent_preview_direction_id_workspace_agent_direction_id_fk" FOREIGN KEY ("direction_id") REFERENCES "public"."workspace_agent_direction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_preview" ADD CONSTRAINT "workspace_agent_preview_card_id_workspace_agent_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."workspace_agent_card"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_preview" ADD CONSTRAINT "workspace_agent_preview_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_preview" ADD CONSTRAINT "workspace_agent_preview_generation_task_id_generation_task_id_fk" FOREIGN KEY ("generation_task_id") REFERENCES "public"."generation_task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_review" ADD CONSTRAINT "workspace_agent_review_workflow_id_workspace_agent_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workspace_agent_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_review" ADD CONSTRAINT "workspace_agent_review_card_id_workspace_agent_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."workspace_agent_card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_review" ADD CONSTRAINT "workspace_agent_review_round_id_workspace_agent_round_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."workspace_agent_round"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_round" ADD CONSTRAINT "workspace_agent_round_workflow_id_workspace_agent_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workspace_agent_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_round" ADD CONSTRAINT "workspace_agent_round_card_id_workspace_agent_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."workspace_agent_card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_round" ADD CONSTRAINT "workspace_agent_round_selected_card_image_id_card_image_id_fk" FOREIGN KEY ("selected_card_image_id") REFERENCES "public"."card_image"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_round" ADD CONSTRAINT "workspace_agent_round_generation_task_id_generation_task_id_fk" FOREIGN KEY ("generation_task_id") REFERENCES "public"."generation_task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_usage" ADD CONSTRAINT "workspace_agent_usage_workflow_id_workspace_agent_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workspace_agent_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_usage" ADD CONSTRAINT "workspace_agent_usage_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_usage" ADD CONSTRAINT "workspace_agent_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_usage" ADD CONSTRAINT "workspace_agent_usage_chat_api_id_chat_api_config_id_fk" FOREIGN KEY ("chat_api_id") REFERENCES "public"."chat_api_config"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_usage" ADD CONSTRAINT "workspace_agent_usage_image_model_id_model_id_fk" FOREIGN KEY ("image_model_id") REFERENCES "public"."model"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_usage" ADD CONSTRAINT "workspace_agent_usage_card_id_workspace_agent_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."workspace_agent_card"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_usage" ADD CONSTRAINT "workspace_agent_usage_round_id_workspace_agent_round_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."workspace_agent_round"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_usage" ADD CONSTRAINT "workspace_agent_usage_card_image_id_card_image_id_fk" FOREIGN KEY ("card_image_id") REFERENCES "public"."card_image"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_usage" ADD CONSTRAINT "workspace_agent_usage_generation_task_id_generation_task_id_fk" FOREIGN KEY ("generation_task_id") REFERENCES "public"."generation_task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_workflow" ADD CONSTRAINT "workspace_agent_workflow_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_workflow" ADD CONSTRAINT "workspace_agent_workflow_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_workflow" ADD CONSTRAINT "workspace_agent_workflow_workspace_task_id_workspace_task_id_fk" FOREIGN KEY ("workspace_task_id") REFERENCES "public"."workspace_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wac_workflow_index_unique" ON "workspace_agent_card" USING btree ("workflow_id","card_index");--> statement-breakpoint
CREATE INDEX "wac_ent_user_status" ON "workspace_agent_card" USING btree ("enterprise_id","user_id","status");--> statement-breakpoint
CREATE INDEX "wad_workflow_sort" ON "workspace_agent_direction" USING btree ("workflow_id","sort_order");--> statement-breakpoint
CREATE INDEX "wae_workflow_created" ON "workspace_agent_event" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "waj_ent_status" ON "workspace_agent_job" USING btree ("enterprise_id","status");--> statement-breakpoint
CREATE INDEX "waj_workflow_created" ON "workspace_agent_job" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "waj_next_retry" ON "workspace_agent_job" USING btree ("next_retry_at") WHERE "workspace_agent_job"."status" = 'queued' AND "workspace_agent_job"."next_retry_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "waoc_card_locale_unique" ON "workspace_agent_oracle_copy" USING btree ("card_id","locale");--> statement-breakpoint
CREATE INDEX "wap_workflow_created" ON "workspace_agent_preview" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "wap_card" ON "workspace_agent_preview" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "warv_round" ON "workspace_agent_review" USING btree ("round_id");--> statement-breakpoint
CREATE INDEX "warv_workflow_created" ON "workspace_agent_review" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "war_card_round_unique" ON "workspace_agent_round" USING btree ("card_id","round_number");--> statement-breakpoint
CREATE INDEX "war_workflow" ON "workspace_agent_round" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "wau_workflow_created" ON "workspace_agent_usage" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "wau_ent_created" ON "workspace_agent_usage" USING btree ("enterprise_id","created_at");--> statement-breakpoint
CREATE INDEX "waw_ent_user_created" ON "workspace_agent_workflow" USING btree ("enterprise_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "waw_status_created" ON "workspace_agent_workflow" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "waw_task" ON "workspace_agent_workflow" USING btree ("workspace_task_id");