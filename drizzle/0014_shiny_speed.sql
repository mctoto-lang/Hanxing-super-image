ALTER TABLE "chat_api_config" ALTER COLUMN "enterprise_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_config" ALTER COLUMN "endpoint" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_config" ALTER COLUMN "model" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_config" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "chat_api_config" ALTER COLUMN "status" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD COLUMN "display_name" varchar(200);--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD COLUMN "badge_text" varchar(30);--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD COLUMN "badge_color" varchar(30);--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD COLUMN "icon_url" text;--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD COLUMN "api_endpoint" text;--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD COLUMN "extra_config" jsonb;--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD COLUMN "task_timeout" integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "chat_api_config" SET "api_endpoint" = "endpoint", "display_name" = "name", "is_active" = COALESCE("status" = 'active', true) WHERE "endpoint" IS NOT NULL OR "status" IS NOT NULL;--> statement-breakpoint
UPDATE "chat_api_config" SET "name" = "model" WHERE NULLIF("model", '') IS NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_config" ALTER COLUMN "display_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_config" ALTER COLUMN "api_endpoint" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_model_name_endpoint_platform_unique" ON "chat_api_config" USING btree ("name","api_endpoint") WHERE "chat_api_config"."enterprise_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_model_name_endpoint_ent_unique" ON "chat_api_config" USING btree ("name","api_endpoint") WHERE "chat_api_config"."enterprise_id" IS NOT NULL;
