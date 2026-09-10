ALTER TABLE "model" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_config" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- 回填：初始顺序 = 现有展示顺序（createdAt 升序）
UPDATE "model" SET "sort_order" = sub.rn FROM (SELECT id, row_number() OVER (ORDER BY created_at) - 1 AS rn FROM "model") sub WHERE "model".id = sub.id;--> statement-breakpoint
UPDATE "chat_api_config" SET "sort_order" = sub.rn FROM (SELECT id, row_number() OVER (ORDER BY created_at) - 1 AS rn FROM "chat_api_config") sub WHERE "chat_api_config".id = sub.id;
