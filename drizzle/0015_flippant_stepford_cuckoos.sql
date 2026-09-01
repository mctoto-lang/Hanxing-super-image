ALTER TABLE "chat_api_config" DROP CONSTRAINT "chat_api_config_status_chk";--> statement-breakpoint
ALTER TABLE "chat_api_config" DROP COLUMN "endpoint";--> statement-breakpoint
ALTER TABLE "chat_api_config" DROP COLUMN "model";--> statement-breakpoint
ALTER TABLE "chat_api_config" DROP COLUMN "status";