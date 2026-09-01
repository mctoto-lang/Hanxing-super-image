CREATE TABLE IF NOT EXISTS "chat_conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"model_id" uuid,
	"thinking_level" varchar(10) DEFAULT 'off' NOT NULL,
	"context_tokens" integer DEFAULT 0 NOT NULL,
	"pinned_at" timestamp with time zone,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(10) NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"thinking_content" text,
	"model_id" uuid,
	"thinking_level" varchar(10),
	"status" varchar(12) DEFAULT 'completed' NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_centicredits" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_message_role_chk" CHECK ("chat_message"."role" IN ('user', 'assistant')),
	CONSTRAINT "chat_message_status_chk" CHECK ("chat_message"."status" IN ('streaming', 'completed', 'failed', 'stopped'))
);
--> statement-breakpoint
ALTER TABLE "enterprise" ADD COLUMN IF NOT EXISTS "visible_preset_chat_models" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "chat_unbilled_centicredits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD COLUMN IF NOT EXISTS "max_context_tokens" integer DEFAULT 32768 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD COLUMN IF NOT EXISTS "max_output_tokens" integer DEFAULT 4096 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD COLUMN IF NOT EXISTS "input_price_centicredits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD COLUMN IF NOT EXISTS "output_price_centicredits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD COLUMN IF NOT EXISTS "supports_thinking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_conversation" DROP CONSTRAINT IF EXISTS "chat_conversation_enterprise_id_enterprise_id_fk";--> statement-breakpoint
ALTER TABLE "chat_conversation" ADD CONSTRAINT "chat_conversation_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversation" DROP CONSTRAINT IF EXISTS "chat_conversation_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "chat_conversation" ADD CONSTRAINT "chat_conversation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversation" DROP CONSTRAINT IF EXISTS "chat_conversation_model_id_chat_api_config_id_fk";--> statement-breakpoint
ALTER TABLE "chat_conversation" ADD CONSTRAINT "chat_conversation_model_id_chat_api_config_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."chat_api_config"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" DROP CONSTRAINT IF EXISTS "chat_message_conversation_id_chat_conversation_id_fk";--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_conversation_id_chat_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" DROP CONSTRAINT IF EXISTS "chat_message_enterprise_id_enterprise_id_fk";--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" DROP CONSTRAINT IF EXISTS "chat_message_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" DROP CONSTRAINT IF EXISTS "chat_message_model_id_chat_api_config_id_fk";--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_model_id_chat_api_config_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."chat_api_config"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_ent_user_last" ON "chat_conversation" USING btree ("enterprise_id","user_id","last_message_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cc_ent_user_pinned" ON "chat_conversation" USING btree ("enterprise_id","user_id","pinned_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cm_conv_created" ON "chat_message" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cm_ent_user_created" ON "chat_message" USING btree ("enterprise_id","user_id","created_at");--> statement-breakpoint
-- 存量企业默认开通 AI 对话模块（幂等：已含 chat 的不再追加）
UPDATE "enterprise" SET "enabled_modules" = ("enabled_modules" || '["chat"]'::jsonb) WHERE NOT ("enabled_modules" ? 'chat');