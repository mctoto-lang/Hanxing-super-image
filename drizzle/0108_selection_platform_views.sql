-- 0108：选品工具平台独立视图（2026-11-24）
--   1. selection_result.rank：平台名次（Amazon BSR / 榜单名次，其余平台 null），
--      供平台标签内按名次排序与表格列展示
--   2. selection_monitor 快照扩列：浏览 / 转发 / 名次 / 币种（监控页最新指标与涨跌对比）
--   3. selection_ai_summary.target_url：一次性抓评论的目标级 AI 洞察（kind='target'，
--      无监控目标时按来源链接归并）
--   4. 存量 Amazon 行从 raw_data 回填 rank
-- 全部幂等（IF NOT EXISTS / WHERE ... IS NULL），不涉及枚举字面量；dev 库可先手工执行，
-- 迁移器重放无副作用。
ALTER TABLE "selection_result" ADD COLUMN IF NOT EXISTS "rank" integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sr_ent_platform_rank" ON "selection_result" ("enterprise_id","platform","rank");--> statement-breakpoint
ALTER TABLE "selection_monitor" ADD COLUMN IF NOT EXISTS "last_views_count" integer;--> statement-breakpoint
ALTER TABLE "selection_monitor" ADD COLUMN IF NOT EXISTS "last_shares_count" integer;--> statement-breakpoint
ALTER TABLE "selection_monitor" ADD COLUMN IF NOT EXISTS "last_rank" integer;--> statement-breakpoint
ALTER TABLE "selection_monitor" ADD COLUMN IF NOT EXISTS "last_currency" varchar(8);--> statement-breakpoint
ALTER TABLE "selection_ai_summary" ADD COLUMN IF NOT EXISTS "target_url" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sas_target" ON "selection_ai_summary" ("enterprise_id","target_url") WHERE kind = 'target' AND target_url IS NOT NULL;--> statement-breakpoint
-- 回填：旧 curious_coder 榜单/商品页行（bestSellersRank[0].rank）；数字串限 9 位防溢出
UPDATE "selection_result"
SET "rank" = (raw_data->'bestSellersRank'->0->>'rank')::integer
WHERE "platform" = 'amazon'
  AND "rank" IS NULL
  AND jsonb_typeof(raw_data->'bestSellersRank') = 'array'
  AND (raw_data->'bestSellersRank'->0->>'rank') ~ '^[0-9]{1,9}$';
