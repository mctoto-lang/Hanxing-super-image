CREATE TABLE "service_status_sample" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_type" varchar(32) NOT NULL,
	"enterprise_id" uuid,
	"day" date NOT NULL,
	"status" varchar(16) NOT NULL,
	"latency_ms" integer,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_sample_unique" UNIQUE NULLS NOT DISTINCT("service_type","enterprise_id","day")
);
--> statement-breakpoint
ALTER TABLE "service_status_sample" ADD CONSTRAINT "service_status_sample_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "status_sample_lookup" ON "service_status_sample" USING btree ("enterprise_id","service_type","day");