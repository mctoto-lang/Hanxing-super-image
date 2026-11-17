-- 视频生成/选品工具模块上线（占位 coming soon 页）：
-- ① 存量企业默认全员开通两模块（enabled_modules 回填）。逐 key 独立 UPDATE +
--    各自 NOT ? 守卫（幂等且不产生重复元素——jsonb 数组 || 拼接不去重，precedent 0080）
UPDATE "enterprise"
SET "enabled_modules" = "enabled_modules" || '["video"]'::jsonb
WHERE NOT "enabled_modules" ? 'video';--> statement-breakpoint

UPDATE "enterprise"
SET "enabled_modules" = "enabled_modules" || '["selection"]'::jsonb
WHERE NOT "enabled_modules" ? 'selection';--> statement-breakpoint

-- ② 权限组非空白名单同步补全（空数组 = 继承企业全部模块，无需回填；逐 key 幂等）
UPDATE "permission_group"
SET "allowed_pages" = "allowed_pages" || '["video"]'::jsonb
WHERE jsonb_array_length("allowed_pages") > 0
  AND NOT "allowed_pages" ? 'video';--> statement-breakpoint

UPDATE "permission_group"
SET "allowed_pages" = "allowed_pages" || '["selection"]'::jsonb
WHERE jsonb_array_length("allowed_pages") > 0
  AND NOT "allowed_pages" ? 'selection';--> statement-breakpoint

-- ③ 新企业默认模块数组对齐 drizzle schema default（enterprise.enabled_modules）
ALTER TABLE "enterprise"
  ALTER COLUMN "enabled_modules" SET DEFAULT
  '["create","chat","assets","mockup","settings","inventory","video","selection"]'::jsonb;
