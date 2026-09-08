ALTER TABLE "service_status_sample" DROP CONSTRAINT "status_sample_unique";--> statement-breakpoint
DROP INDEX "status_sample_lookup";--> statement-breakpoint
ALTER TABLE "service_status_sample" DROP COLUMN "day";