CREATE TABLE "agent_asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"kind" varchar(16) NOT NULL,
	"name" varchar(200),
	"url" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"role" varchar(12) NOT NULL,
	"content" text NOT NULL,
	"node_key" varchar(60),
	"item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_item" ADD COLUMN "visual_brief" text;--> statement-breakpoint
ALTER TABLE "agent_run_item" ADD COLUMN "framed_image_url" text;--> statement-breakpoint
ALTER TABLE "agent_run_item" ADD COLUMN "frame_status" varchar(12);--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "template" varchar(60);--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "stage" varchar(16);--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "title" varchar(120);--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "brief" text;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "directions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "selected_direction" varchar(20);--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "frame_mode" varchar(12) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "frame_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_asset" ADD CONSTRAINT "agent_asset_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_message" ADD CONSTRAINT "agent_message_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aas_run_created" ON "agent_asset" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "amsg_run_created" ON "agent_message" USING btree ("run_id","created_at");