ALTER TABLE "service_status_sample" ADD COLUMN "slot" timestamp with time zone NOT NULL;--> statement-breakpoint
CREATE INDEX "status_sample_lookup" ON "service_status_sample" USING btree ("enterprise_id","service_type","slot");--> statement-breakpoint
ALTER TABLE "service_status_sample" ADD CONSTRAINT "status_sample_unique" UNIQUE NULLS NOT DISTINCT("service_type","enterprise_id","slot");