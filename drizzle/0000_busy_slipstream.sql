CREATE TYPE "public"."api_format" AS ENUM('grs', 'jimeng');--> statement-breakpoint
CREATE TYPE "public"."credit_tx_type" AS ENUM('recharge', 'consumption', 'refund', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."enterprise_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."enterprise_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."task_source" AS ENUM('create', 'workspace', 'product');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('queued', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('normal', 'workspace_single', 'workspace_batch', 'product');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "enterprise" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(50) NOT NULL,
	"logo_url" text,
	"status" "enterprise_status" DEFAULT 'active' NOT NULL,
	"credits_balance" integer DEFAULT 0 NOT NULL,
	"enabled_modules" jsonb DEFAULT '["create","chat","assets","mockup","settings"]'::jsonb NOT NULL,
	"max_concurrent" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enterprise_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "permission_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"allowed_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_concurrent" integer DEFAULT 2 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(255) NOT NULL,
	"provider" varchar(255) NOT NULL,
	"provider_account_id" varchar(255) NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" varchar(255),
	"scope" varchar(255),
	"id_token" text,
	"session_state" varchar(255),
	CONSTRAINT "account_provider_unique" UNIQUE("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_token" varchar(255) NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "session_session_token_unique" UNIQUE("session_token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(50) NOT NULL,
	"email" varchar(255),
	"name" varchar(100),
	"password_hash" varchar(255) NOT NULL,
	"image" text,
	"is_super_admin" boolean DEFAULT false NOT NULL,
	"enterprise_id" uuid,
	"enterprise_role" "enterprise_role" DEFAULT 'member' NOT NULL,
	"group_id" uuid,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email_verified" timestamp with time zone,
	CONSTRAINT "user_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "verificationtoken" (
	"identifier" varchar(255) NOT NULL,
	"token" varchar(255) NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verificationtoken_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "credit_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" uuid NOT NULL,
	"user_id" uuid,
	"type" "credit_tx_type" NOT NULL,
	"amount" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"task_id" uuid,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"username" varchar(50),
	"enterprise_id" uuid,
	"ip" varchar(64) NOT NULL,
	"user_agent" text,
	"success" boolean NOT NULL,
	"failure_reason" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "permission_group" ADD CONSTRAINT "permission_group_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_group_id_permission_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."permission_group"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transaction" ADD CONSTRAINT "credit_transaction_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transaction" ADD CONSTRAINT "credit_transaction_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_log" ADD CONSTRAINT "login_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_log" ADD CONSTRAINT "login_log_enterprise_id_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."enterprise"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_default_per_enterprise" ON "permission_group" USING btree ("enterprise_id") WHERE is_default = true;--> statement-breakpoint
CREATE INDEX "pg_ent" ON "permission_group" USING btree ("enterprise_id");--> statement-breakpoint
CREATE INDEX "user_ent" ON "user" USING btree ("enterprise_id");--> statement-breakpoint
CREATE INDEX "user_super" ON "user" USING btree ("is_super_admin");--> statement-breakpoint
CREATE INDEX "ct_ent_created" ON "credit_transaction" USING btree ("enterprise_id","created_at");--> statement-breakpoint
CREATE INDEX "ll_ip_created" ON "login_log" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "ll_ent_created" ON "login_log" USING btree ("enterprise_id","created_at");--> statement-breakpoint
CREATE INDEX "ll_user" ON "login_log" USING btree ("user_id");