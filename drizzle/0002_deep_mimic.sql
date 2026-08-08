CREATE TABLE "model" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid,
	"name" varchar(100) NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"api_endpoint" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"api_format" "api_format" DEFAULT 'grs' NOT NULL,
	"extra_config" jsonb,
	"cost_per_image" integer DEFAULT 1 NOT NULL,
	"supported_sizes" jsonb,
	"visible_in_create" boolean DEFAULT true NOT NULL,
	"visible_in_workspace" boolean DEFAULT false NOT NULL,
	"visible_in_product" boolean DEFAULT false NOT NULL,
	"supports_reference_image" boolean DEFAULT false NOT NULL,
	"max_reference_images" integer DEFAULT 0 NOT NULL,
	"reference_image_field" varchar(50) DEFAULT 'images',
	"max_concurrent" integer DEFAULT 2 NOT NULL,
	"max_retries" integer DEFAULT 2 NOT NULL,
	"api_timeout" integer DEFAULT 120 NOT NULL,
	"task_timeout" integer DEFAULT 300 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"icon_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_name_endpoint_ent_unique" UNIQUE("name","api_endpoint","enterprise_id")
);
--> statement-breakpoint
CREATE TABLE "api_call_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"task_id" uuid,
	"model_id" uuid,
	"request_summary" text,
	"response_summary" text,
	"error_message" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"image_size" varchar(30),
	"image_count" integer DEFAULT 1 NOT NULL,
	"status" "task_status" DEFAULT 'queued' NOT NULL,
	"task_type" "task_type" DEFAULT 'normal' NOT NULL,
	"source" "task_source" DEFAULT 'create' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"credits_charged" integer DEFAULT 0 NOT NULL,
	"result_images" jsonb,
	"reference_images" jsonb,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"retry_errors" jsonb,
	"template_info" jsonb,
	"task_uuid" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pinned_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"source" "task_source" DEFAULT 'create' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_setting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid,
	"key" varchar(100) NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setting_key_ent_unique" UNIQUE("key","enterprise_id")
);
--> statement-breakpoint
ALTER TABLE "model" ADD CONSTRAINT "model_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_call_log" ADD CONSTRAINT "api_call_log_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_call_log" ADD CONSTRAINT "api_call_log_task_id_generation_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."generation_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_task" ADD CONSTRAINT "generation_task_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_task" ADD CONSTRAINT "generation_task_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_task" ADD CONSTRAINT "generation_task_model_id_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_task" ADD CONSTRAINT "pinned_task_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_task" ADD CONSTRAINT "pinned_task_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinned_task" ADD CONSTRAINT "pinned_task_task_id_generation_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."generation_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_setting" ADD CONSTRAINT "system_setting_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_ent" ON "model" USING btree ("enterprise_id");--> statement-breakpoint
CREATE INDEX "model_active_create" ON "model" USING btree ("is_active","visible_in_create");--> statement-breakpoint
CREATE INDEX "acl_ent_created" ON "api_call_log" USING btree ("enterprise_id","created_at");--> statement-breakpoint
CREATE INDEX "gt_ent_status" ON "generation_task" USING btree ("enterprise_id","status");--> statement-breakpoint
CREATE INDEX "gt_ent_user_created" ON "generation_task" USING btree ("enterprise_id","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gt_uuid" ON "generation_task" USING btree ("task_uuid");--> statement-breakpoint
CREATE UNIQUE INDEX "pt_ent_user_task" ON "pinned_task" USING btree ("enterprise_id","user_id","task_id");--> statement-breakpoint
CREATE INDEX "pt_ent_user" ON "pinned_task" USING btree ("enterprise_id","user_id");--> statement-breakpoint
CREATE INDEX "setting_ent" ON "system_setting" USING btree ("enterprise_id");