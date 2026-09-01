ALTER TABLE "product_model_alias" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_ratio_alias" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "product_model_alias" CASCADE;--> statement-breakpoint
DROP TABLE "product_ratio_alias" CASCADE;--> statement-breakpoint
ALTER TABLE "model" ALTER COLUMN "api_format" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "model" ALTER COLUMN "api_format" SET DEFAULT 'openai'::text;--> statement-breakpoint
UPDATE "model" SET "api_format" = 'openai' WHERE "api_format" = 'grs';--> statement-breakpoint
UPDATE "model" SET "extra_config" = '{}'::jsonb WHERE "api_format" = 'openai' AND "extra_config" ?| array['grsModelFamily','grs_model_family','replyType','reply_type','imageSizeGrs','image_size_grs'];--> statement-breakpoint
UPDATE "model" SET "reference_image_field" = NULL WHERE "api_format" = 'openai' AND "reference_image_field" = 'images';--> statement-breakpoint
DROP TYPE "public"."api_format";--> statement-breakpoint
CREATE TYPE "public"."api_format" AS ENUM('openai', 'jimeng');--> statement-breakpoint
ALTER TABLE "model" ALTER COLUMN "api_format" SET DEFAULT 'openai'::"public"."api_format";--> statement-breakpoint
ALTER TABLE "model" ALTER COLUMN "api_format" SET DATA TYPE "public"."api_format" USING "api_format"::"public"."api_format";