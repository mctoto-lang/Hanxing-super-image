ALTER TABLE "chat_api_config" ADD COLUMN "supports_vision" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_message" ADD COLUMN "images" jsonb DEFAULT '[]'::jsonb NOT NULL;