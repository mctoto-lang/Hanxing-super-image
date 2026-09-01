ALTER TYPE "public"."credit_tx_type" ADD VALUE 'allocation';--> statement-breakpoint
ALTER TYPE "public"."credit_tx_type" ADD VALUE 'allocation_deduct';--> statement-breakpoint
ALTER TYPE "public"."credit_tx_type" ADD VALUE 'allocation_refund';--> statement-breakpoint
ALTER TABLE "enterprise" ADD COLUMN "allow_custom_models" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "enterprise" ADD COLUMN "visible_preset_models" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "credits_balance" integer DEFAULT 0 NOT NULL;