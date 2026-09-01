ALTER TABLE "generation_task" ADD COLUMN "cost_per_image" integer;--> statement-breakpoint
ALTER TABLE "generation_task" ADD COLUMN "succeeded_indexes" jsonb;