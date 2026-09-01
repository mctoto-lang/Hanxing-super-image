ALTER TABLE "product_main_template" DROP CONSTRAINT "product_main_template_group_id_product_template_group_id_fk";
--> statement-breakpoint
ALTER TABLE "product_main_template" ALTER COLUMN "group_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "product_main_template" ALTER COLUMN "prompt_template" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "product_main_template" ALTER COLUMN "is_active" SET DATA TYPE boolean;--> statement-breakpoint
ALTER TABLE "product_main_template" ALTER COLUMN "is_active" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "product_library_image" ADD COLUMN "name" varchar(200);--> statement-breakpoint
ALTER TABLE "product_main_template" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "product_main_template" ADD COLUMN "visibility" varchar(20) DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_main_template" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "product_sub_template" ADD COLUMN "preview_image_url" text;--> statement-breakpoint
ALTER TABLE "product_sub_template" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "product_template_group" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "product_template_group" ADD COLUMN "badge_color" varchar(30) DEFAULT 'slate' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_template_group" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "product_main_template" ADD CONSTRAINT "product_main_template_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_main_template" ADD CONSTRAINT "product_main_template_group_id_product_template_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."product_template_group"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_template_group" ADD CONSTRAINT "product_template_group_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ptg_ent_user_name" ON "product_template_group" USING btree ("enterprise_id","user_id","name");