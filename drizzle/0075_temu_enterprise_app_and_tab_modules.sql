-- ① TEMU 应用凭证改企业级：平台级行（enterprise_id IS NULL，历史可能多行）取 updatedAt
-- 最新一条复制给所有已开通 temu 模块的企业（行为零变化）；仅当实际复制到 ≥1 家企业时
-- 才删除平台级行，避免「未复制即删除」导致凭证不留任何副本。
WITH ins AS (
  INSERT INTO "system_setting" ("enterprise_id", "key", "value", "description", "updated_at")
  SELECT e."id", p."key", p."value", 'TEMU 官方开放平台应用凭证（app_key/secret，企业级）', p."updated_at"
  FROM "enterprise" e
  CROSS JOIN (
    SELECT *
    FROM "system_setting" s
    WHERE s."key" = 'temu_api_app' AND s."enterprise_id" IS NULL
    ORDER BY s."updated_at" DESC
    LIMIT 1
  ) p
  WHERE e."enabled_modules" ? 'temu'
  ON CONFLICT ("key", "enterprise_id") DO NOTHING
  RETURNING 1
)
DELETE FROM "system_setting"
WHERE "key" = 'temu_api_app' AND "enterprise_id" IS NULL
  AND EXISTS (SELECT 1 FROM ins);--> statement-breakpoint

-- ② TEMU tab 子模块回填：已开通 temu 的企业/权限组同步补全 7 个 tab 子权限
--（存量用户可见内容零变化；店铺 tab 不设权限项、仅企业管理员可见）
UPDATE "enterprise"
SET "enabled_modules" = "enabled_modules" || '["temu_overview","temu_products","temu_publish","temu_ads","temu_price","temu_purchase","temu_qc"]'::jsonb
WHERE "enabled_modules" ? 'temu'
  AND NOT "enabled_modules" ? 'temu_overview';--> statement-breakpoint

UPDATE "permission_group"
SET "allowed_pages" = "allowed_pages" || '["temu_overview","temu_products","temu_publish","temu_ads","temu_price","temu_purchase","temu_qc"]'::jsonb
WHERE "allowed_pages" ? 'temu'
  AND NOT "allowed_pages" ? 'temu_overview';
