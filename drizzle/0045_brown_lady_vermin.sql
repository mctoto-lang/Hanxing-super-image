ALTER TYPE "public"."api_format" ADD VALUE 'gemini';--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "use_ratio_param" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "ratio_param_field" varchar(50);