CREATE TABLE "weartry_figure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"image_url" text NOT NULL,
	"source" varchar(10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "weartry_figure" ADD CONSTRAINT "weartry_figure_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weartry_figure" ADD CONSTRAINT "weartry_figure_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wf_user_image_unique" ON "weartry_figure" USING btree ("user_id","image_url");--> statement-breakpoint
CREATE INDEX "wf_user_created" ON "weartry_figure" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "weartry_scene" DROP COLUMN "cover_url";