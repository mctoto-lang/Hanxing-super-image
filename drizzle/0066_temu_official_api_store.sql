-- TEMU 官方 API 对接（M0）：店铺凭证由插件 deviceToken 换为店铺级 access_token
-- （AES-256-GCM 密文落库），补同步调度与 token 状态列；插件在线判据 last_seen_at
-- 随插件链路移除；插件发现店铺表整体删除（幂等，本地 dev 与生产均可安全执行）。
ALTER TABLE "temu_store" DROP COLUMN IF EXISTS "device_token";--> statement-breakpoint
DROP INDEX IF EXISTS "gt_temu_store_token";--> statement-breakpoint
ALTER TABLE "temu_store" DROP COLUMN IF EXISTS "last_seen_at";--> statement-breakpoint
ALTER TABLE "temu_store" ADD COLUMN IF NOT EXISTS "access_token_encrypted" text;--> statement-breakpoint
ALTER TABLE "temu_store" ADD COLUMN IF NOT EXISTS "mall_type" varchar(16);--> statement-breakpoint
ALTER TABLE "temu_store" ADD COLUMN IF NOT EXISTS "token_state" varchar(16) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "temu_store" ADD COLUMN IF NOT EXISTS "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "temu_store" ADD COLUMN IF NOT EXISTS "sync_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "temu_store" ADD COLUMN IF NOT EXISTS "last_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "temu_store" ADD COLUMN IF NOT EXISTS "last_sync_status" jsonb;--> statement-breakpoint
DROP TABLE IF EXISTS "temu_discovered_mall";
