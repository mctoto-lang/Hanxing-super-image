ALTER TABLE "model" DROP CONSTRAINT "model_name_endpoint_ent_unique";--> statement-breakpoint
ALTER TABLE "chat_task" ADD COLUMN "next_retry_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "model_name_endpoint_ent_unique" ON "model" USING btree ("name","api_endpoint","enterprise_id") WHERE "model"."enterprise_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "model_name_endpoint_platform_unique" ON "model" USING btree ("name","api_endpoint") WHERE "model"."enterprise_id" IS NULL;--> statement-breakpoint
CREATE INDEX "chat_task_next_retry" ON "chat_task" USING btree ("next_retry_at") WHERE "chat_task"."status" = 'queued' AND "chat_task"."next_retry_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "card_image" ADD CONSTRAINT "card_image_status_chk" CHECK ("card_image"."status" IN ('pending', 'generating', 'completed', 'failed'));--> statement-breakpoint
ALTER TABLE "card_image" ADD CONSTRAINT "card_image_format_chk" CHECK ("card_image"."format" IN ('png', 'jpg', 'jpeg', 'webp'));--> statement-breakpoint
ALTER TABLE "card_image" ADD CONSTRAINT "card_image_source_chk" CHECK ("card_image"."source" IN ('generated', 'uploaded'));--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD CONSTRAINT "chat_api_config_status_chk" CHECK ("chat_api_config"."status" IN ('active', 'inactive'));--> statement-breakpoint
ALTER TABLE "chat_task" ADD CONSTRAINT "chat_task_status_chk" CHECK ("chat_task"."status" IN ('queued', 'processing', 'completed', 'failed'));--> statement-breakpoint
ALTER TABLE "chat_task" ADD CONSTRAINT "chat_task_task_type_chk" CHECK ("chat_task"."task_type" IN ('deepen', 'regenerate', 'translate'));--> statement-breakpoint
ALTER TABLE "prompt_card" ADD CONSTRAINT "prompt_card_translation_status_chk" CHECK ("prompt_card"."translation_status" IN ('none', 'translating', 'synced', 'outdated', 'failed'));--> statement-breakpoint
ALTER TABLE "prompt_card" ADD CONSTRAINT "prompt_card_display_language_chk" CHECK ("prompt_card"."display_language" IN ('zh', 'en'));--> statement-breakpoint
ALTER TABLE "prompt_template" ADD CONSTRAINT "prompt_template_type_chk" CHECK ("prompt_template"."type" IN ('fission', 'deepen', 'regenerate', 'extract', 'translate'));--> statement-breakpoint
ALTER TABLE "prompt_template" ADD CONSTRAINT "prompt_template_visibility_chk" CHECK ("prompt_template"."visibility" IN ('private', 'public'));--> statement-breakpoint
ALTER TABLE "prompt_template" ADD CONSTRAINT "prompt_template_status_chk" CHECK ("prompt_template"."status" IN ('active', 'archived'));--> statement-breakpoint
ALTER TABLE "workspace_api_log" ADD CONSTRAINT "workspace_api_log_api_type_chk" CHECK ("workspace_api_log"."api_type" IN ('chat', 'image'));--> statement-breakpoint
ALTER TABLE "workspace_api_log" ADD CONSTRAINT "workspace_api_log_response_status_chk" CHECK ("workspace_api_log"."response_status" IN ('success', 'failure', 'timeout'));--> statement-breakpoint
ALTER TABLE "workspace_task" ADD CONSTRAINT "workspace_task_status_chk" CHECK ("workspace_task"."status" IN ('generating', 'completed', 'failed'));--> statement-breakpoint
ALTER TABLE "product_main_template" ADD CONSTRAINT "product_main_template_visibility_chk" CHECK ("product_main_template"."visibility" IN ('private', 'public'));