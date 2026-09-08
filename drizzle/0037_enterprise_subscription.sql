ALTER TYPE "public"."credit_tx_type" ADD VALUE 'plan_grant';--> statement-breakpoint
CREATE TABLE "enterprise_subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_grant_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_subscription_enterprise_id_unique" UNIQUE("enterprise_id")
);
--> statement-breakpoint
CREATE TABLE "plan_credit_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"credits_granted" integer NOT NULL,
	"transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(50) NOT NULL,
	"icon_key" varchar(50) DEFAULT 'medal' NOT NULL,
	"color" varchar(7) DEFAULT '#8b5cf6' NOT NULL,
	"credits_per_cycle" integer NOT NULL,
	"cycle_days" integer DEFAULT 30 NOT NULL,
	"max_members" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_plan_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "enterprise_subscription" ADD CONSTRAINT "enterprise_subscription_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_subscription" ADD CONSTRAINT "enterprise_subscription_plan_id_subscription_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plan"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_credit_grant" ADD CONSTRAINT "plan_credit_grant_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_credit_grant" ADD CONSTRAINT "plan_credit_grant_plan_id_subscription_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plan"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_credit_grant" ADD CONSTRAINT "plan_credit_grant_transaction_id_credit_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."credit_transaction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "es_plan" ON "enterprise_subscription" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pcg_ent_period" ON "plan_credit_grant" USING btree ("enterprise_id","period_start");--> statement-breakpoint
CREATE INDEX "pcg_ent_created" ON "plan_credit_grant" USING btree ("enterprise_id","created_at");--> statement-breakpoint
-- 种子套餐（对齐营销页 pricing-section：Lite/Pro/Max 月积分与人数上限）
INSERT INTO "subscription_plan" ("id", "name", "icon_key", "color", "credits_per_cycle", "cycle_days", "max_members", "sort_order") VALUES
  ('a0000000-0000-4000-8000-000000000001', 'Lite', 'leaf', '#10b981', 10000, 30, 5, 10),
  ('a0000000-0000-4000-8000-000000000002', 'Pro', 'crown', '#8b5cf6', 50000, 30, 20, 20),
  ('a0000000-0000-4000-8000-000000000003', 'Max', 'rocket', '#f59e0b', 100000, 30, 50, 30)
ON CONFLICT ("name") DO NOTHING;