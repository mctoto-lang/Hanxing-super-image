-- 模型显示增强：描述 / 勋章 / 结构化尺寸预设 / 数量开关；移除 supported_sizes
ALTER TABLE "model" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "badge_text" varchar(30);--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "badge_color" varchar(30);--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "size_presets" jsonb;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "supports_image_count" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model" DROP COLUMN "supported_sizes";
