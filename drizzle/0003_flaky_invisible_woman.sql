CREATE TABLE "card_image" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"image_api_id" uuid,
	"image_url" text NOT NULL,
	"size" varchar(30),
	"format" varchar(10) DEFAULT 'png' NOT NULL,
	"status" varchar(20) DEFAULT 'generating' NOT NULL,
	"error_message" text,
	"is_selected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_api_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"endpoint" text NOT NULL,
	"model" varchar(100) NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"format_type" varchar(30) DEFAULT 'openai' NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"api_config_id" uuid,
	"messages" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"response" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "prompt_card" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"card_index" integer NOT NULL,
	"prompt" text NOT NULL,
	"selected_image_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"type" varchar(30) NOT NULL,
	"name" varchar(100) NOT NULL,
	"content" text NOT NULL,
	"chat_api_id" uuid,
	"fission_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_api_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid,
	"api_type" varchar(30) NOT NULL,
	"api_config_id" uuid,
	"api_config_name" varchar(100),
	"workspace_task_id" uuid,
	"card_id" uuid,
	"request_params" text,
	"response_status" varchar(20) DEFAULT 'success' NOT NULL,
	"response_body" text,
	"duration_ms" integer,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_pinned_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wpt_ent_user_task" UNIQUE("enterprise_id","user_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"theme_prompt" text NOT NULL,
	"template_id" uuid,
	"status" varchar(20) DEFAULT 'generating' NOT NULL,
	"card_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_library_image" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" uuid,
	"main_template_id" uuid,
	"sub_template_id" uuid,
	"product_name" varchar(200),
	"image_url" text NOT NULL,
	"size" varchar(30),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_main_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"icon_url" text,
	"prompt_template" text NOT NULL,
	"default_size" varchar(30) DEFAULT '1024x1024' NOT NULL,
	"model_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_sub_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"main_template_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"scene_prompt" text NOT NULL,
	"negative_prompt" text,
	"extra_config" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_template_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "card_image" ADD CONSTRAINT "card_image_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_image" ADD CONSTRAINT "card_image_card_id_prompt_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."prompt_card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_image" ADD CONSTRAINT "card_image_image_api_id_model_id_fk" FOREIGN KEY ("image_api_id") REFERENCES "public"."model"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD CONSTRAINT "chat_api_config_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_task" ADD CONSTRAINT "chat_task_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_task" ADD CONSTRAINT "chat_task_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_task" ADD CONSTRAINT "chat_task_api_config_id_chat_api_config_id_fk" FOREIGN KEY ("api_config_id") REFERENCES "public"."chat_api_config"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_card" ADD CONSTRAINT "prompt_card_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_card" ADD CONSTRAINT "prompt_card_task_id_workspace_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."workspace_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_template" ADD CONSTRAINT "prompt_template_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_template" ADD CONSTRAINT "prompt_template_chat_api_id_chat_api_config_id_fk" FOREIGN KEY ("chat_api_id") REFERENCES "public"."chat_api_config"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_api_log" ADD CONSTRAINT "workspace_api_log_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_api_log" ADD CONSTRAINT "workspace_api_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_api_log" ADD CONSTRAINT "workspace_api_log_workspace_task_id_workspace_task_id_fk" FOREIGN KEY ("workspace_task_id") REFERENCES "public"."workspace_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_api_log" ADD CONSTRAINT "workspace_api_log_card_id_prompt_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."prompt_card"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_pinned_task" ADD CONSTRAINT "workspace_pinned_task_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_pinned_task" ADD CONSTRAINT "workspace_pinned_task_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_pinned_task" ADD CONSTRAINT "workspace_pinned_task_task_id_workspace_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."workspace_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_task" ADD CONSTRAINT "workspace_task_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_task" ADD CONSTRAINT "workspace_task_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_task" ADD CONSTRAINT "workspace_task_template_id_prompt_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."prompt_template"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_library_image" ADD CONSTRAINT "product_library_image_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_library_image" ADD CONSTRAINT "product_library_image_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_library_image" ADD CONSTRAINT "product_library_image_main_template_id_product_main_template_id_fk" FOREIGN KEY ("main_template_id") REFERENCES "public"."product_main_template"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_library_image" ADD CONSTRAINT "product_library_image_sub_template_id_product_sub_template_id_fk" FOREIGN KEY ("sub_template_id") REFERENCES "public"."product_sub_template"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_main_template" ADD CONSTRAINT "product_main_template_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_main_template" ADD CONSTRAINT "product_main_template_group_id_product_template_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."product_template_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_main_template" ADD CONSTRAINT "product_main_template_model_id_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_sub_template" ADD CONSTRAINT "product_sub_template_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_sub_template" ADD CONSTRAINT "product_sub_template_main_template_id_product_main_template_id_fk" FOREIGN KEY ("main_template_id") REFERENCES "public"."product_main_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_template_group" ADD CONSTRAINT "product_template_group_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ci_ent_card" ON "card_image" USING btree ("enterprise_id","card_id");--> statement-breakpoint
CREATE INDEX "cac_ent" ON "chat_api_config" USING btree ("enterprise_id");--> statement-breakpoint
CREATE INDEX "chat_ent_status" ON "chat_task" USING btree ("enterprise_id","status");--> statement-breakpoint
CREATE INDEX "pc_ent_task" ON "prompt_card" USING btree ("enterprise_id","task_id");--> statement-breakpoint
CREATE INDEX "pt_ent_type" ON "prompt_template" USING btree ("enterprise_id","type");--> statement-breakpoint
CREATE INDEX "wal_ent_created" ON "workspace_api_log" USING btree ("enterprise_id","created_at");--> statement-breakpoint
CREATE INDEX "wt_ent_user" ON "workspace_task" USING btree ("enterprise_id","user_id");--> statement-breakpoint
CREATE INDEX "wt_ent_status" ON "workspace_task" USING btree ("enterprise_id","status");--> statement-breakpoint
CREATE INDEX "pli_ent_user" ON "product_library_image" USING btree ("enterprise_id","user_id");--> statement-breakpoint
CREATE INDEX "pmt_ent_group" ON "product_main_template" USING btree ("enterprise_id","group_id");--> statement-breakpoint
CREATE INDEX "pst_ent_main" ON "product_sub_template" USING btree ("enterprise_id","main_template_id");--> statement-breakpoint
CREATE INDEX "ptg_ent" ON "product_template_group" USING btree ("enterprise_id");