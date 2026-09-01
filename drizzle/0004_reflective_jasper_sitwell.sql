ALTER TABLE "chat_task" ALTER COLUMN "messages" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "card_image" ADD COLUMN "generation_task_id" uuid;--> statement-breakpoint
ALTER TABLE "card_image" ADD COLUMN "generation_prompt" text;--> statement-breakpoint
ALTER TABLE "card_image" ADD COLUMN "source" varchar(20) DEFAULT 'generated' NOT NULL;--> statement-breakpoint
ALTER TABLE "card_image" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD COLUMN "max_concurrent" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD COLUMN "max_retries" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD COLUMN "api_timeout" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_task" ADD COLUMN "task_type" varchar(20) DEFAULT 'deepen' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_task" ADD COLUMN "card_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_task" ADD COLUMN "workspace_task_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_task" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_task" ADD COLUMN "original_prompt" text NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_task" ADD COLUMN "result_prompt" text;--> statement-breakpoint
ALTER TABLE "chat_task" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_task" ADD COLUMN "retry_errors" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_task" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prompt_card" ADD COLUMN "translated_prompt" text;--> statement-breakpoint
ALTER TABLE "prompt_card" ADD COLUMN "translation_source_prompt" text;--> statement-breakpoint
ALTER TABLE "prompt_card" ADD COLUMN "translation_status" varchar(20) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "prompt_card" ADD COLUMN "translation_template_id" uuid;--> statement-breakpoint
ALTER TABLE "prompt_card" ADD COLUMN "display_language" varchar(5) DEFAULT 'zh' NOT NULL;--> statement-breakpoint
ALTER TABLE "prompt_card" ADD COLUMN "reference_images" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "prompt_card" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "prompt_template" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "prompt_template" ADD COLUMN "visibility" varchar(20) DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "prompt_template" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "prompt_template" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_api_log" ADD COLUMN "generation_task_id" uuid;--> statement-breakpoint
ALTER TABLE "card_image" ADD CONSTRAINT "card_image_generation_task_id_generation_task_id_fk" FOREIGN KEY ("generation_task_id") REFERENCES "public"."generation_task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_task" ADD CONSTRAINT "chat_task_card_id_prompt_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."prompt_card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_task" ADD CONSTRAINT "chat_task_workspace_task_id_workspace_task_id_fk" FOREIGN KEY ("workspace_task_id") REFERENCES "public"."workspace_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_task" ADD CONSTRAINT "chat_task_template_id_prompt_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."prompt_template"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_card" ADD CONSTRAINT "prompt_card_translation_template_id_prompt_template_id_fk" FOREIGN KEY ("translation_template_id") REFERENCES "public"."prompt_template"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_template" ADD CONSTRAINT "prompt_template_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_api_log" ADD CONSTRAINT "workspace_api_log_generation_task_id_generation_task_id_fk" FOREIGN KEY ("generation_task_id") REFERENCES "public"."generation_task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_ent_api" ON "chat_task" USING btree ("enterprise_id","api_config_id");