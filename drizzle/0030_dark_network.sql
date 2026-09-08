CREATE TABLE "mockup_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"external_template_id" varchar(64) NOT NULL,
	"template_version_id" varchar(64) NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"bindings" jsonb,
	"fixed_config" jsonb,
	"total_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mockup_template_extra" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"external_template_id" varchar(64) NOT NULL,
	"background_binding_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mockup_group" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
UPDATE "mockup_group" g SET "owner_user_id" = (
	SELECT u.id FROM "user" u
	WHERE u.enterprise_id = g.enterprise_id
	ORDER BY CASE u.enterprise_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.created_at
	LIMIT 1
);--> statement-breakpoint
ALTER TABLE "mockup_group" ALTER COLUMN "owner_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mockup_group" ADD COLUMN "visibility" varchar(16) DEFAULT 'private' NOT NULL;--> statement-breakpoint
UPDATE "mockup_group" SET "visibility" = 'public';--> statement-breakpoint
ALTER TABLE "mockup_group" ADD COLUMN "auto_generated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mockup_batch" ADD CONSTRAINT "mockup_batch_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_batch" ADD CONSTRAINT "mockup_batch_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_template_extra" ADD CONSTRAINT "mockup_template_extra_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mb_ent_user_created" ON "mockup_batch" USING btree ("enterprise_id","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mte_ent_template_unique" ON "mockup_template_extra" USING btree ("enterprise_id","external_template_id");--> statement-breakpoint
ALTER TABLE "mockup_group" ADD CONSTRAINT "mockup_group_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mg_ent_vis_sort" ON "mockup_group" USING btree ("enterprise_id","visibility","sort_order");