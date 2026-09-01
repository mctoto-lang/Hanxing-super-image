ALTER TYPE "public"."task_source" ADD VALUE 'mockup';--> statement-breakpoint
ALTER TYPE "public"."task_type" ADD VALUE 'mockup';--> statement-breakpoint
CREATE TABLE "mockup_card" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"title" varchar(120) NOT NULL,
	"binding_config" jsonb,
	"last_batch_tag" varchar(32),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mockup_design_asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"image_url" text NOT NULL,
	"file_name" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mockup_external_asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"image_url" text NOT NULL,
	"asset_id" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mockup_group_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"template_version_id" varchar(64) NOT NULL,
	"external_template_id" varchar(64) NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"canvas_width" integer,
	"canvas_height" integer,
	"bindings" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mockup_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "generation_task" ALTER COLUMN "model_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mockup_card" ADD CONSTRAINT "mockup_card_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_card" ADD CONSTRAINT "mockup_card_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_card" ADD CONSTRAINT "mockup_card_group_id_mockup_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."mockup_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_design_asset" ADD CONSTRAINT "mockup_design_asset_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_design_asset" ADD CONSTRAINT "mockup_design_asset_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_external_asset" ADD CONSTRAINT "mockup_external_asset_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_group_item" ADD CONSTRAINT "mockup_group_item_group_id_mockup_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."mockup_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_group" ADD CONSTRAINT "mockup_group_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mc_ent_user_sort" ON "mockup_card" USING btree ("enterprise_id","user_id","sort_order");--> statement-breakpoint
CREATE INDEX "mc_ent_user_updated" ON "mockup_card" USING btree ("enterprise_id","user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mda_user_image_unique" ON "mockup_design_asset" USING btree ("user_id","image_url");--> statement-breakpoint
CREATE INDEX "mda_user_created" ON "mockup_design_asset" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mea_ent_image_unique" ON "mockup_external_asset" USING btree ("enterprise_id","image_url");--> statement-breakpoint
CREATE INDEX "mgi_group_sort" ON "mockup_group_item" USING btree ("group_id","sort_order");--> statement-breakpoint
CREATE INDEX "mg_ent_sort" ON "mockup_group" USING btree ("enterprise_id","sort_order");