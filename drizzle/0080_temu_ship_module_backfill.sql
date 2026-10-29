-- 新模块 temu_ship / temu_return（发货/退货 tab，0079-0081 批次同批引入 _shared.ts）
-- 回填存量企业——precedent 0022(chat)/0027(weartry)：enabled_modules 是企业表存量
-- jsonb 数组，新 key 不会自动进入，不回填则存量企业权限组里看得到「发货/退货」
-- 勾选项、TEMU 页却不出 tab（交集判定 enterprise∩group）。
-- 口径：已开通任一 TEMU 业务 tab 的企业补上发货与退货；权限组 allowed_pages 不动，
-- 各组按需勾选。逐 key 独立 UPDATE + 各自 NOT ? 守卫（幂等且不产生重复元素——
-- jsonb 数组 || 拼接不去重）。
UPDATE "enterprise"
SET "enabled_modules" = "enabled_modules" || '["temu_ship"]'::jsonb
WHERE NOT ("enabled_modules" ? 'temu_ship')
  AND (
    "enabled_modules" ? 'temu_overview'
    OR "enabled_modules" ? 'temu_products'
    OR "enabled_modules" ? 'temu_publish'
    OR "enabled_modules" ? 'temu_ads'
    OR "enabled_modules" ? 'temu_price'
    OR "enabled_modules" ? 'temu_purchase'
    OR "enabled_modules" ? 'temu_qc'
  );

UPDATE "enterprise"
SET "enabled_modules" = "enabled_modules" || '["temu_return"]'::jsonb
WHERE NOT ("enabled_modules" ? 'temu_return')
  AND (
    "enabled_modules" ? 'temu_overview'
    OR "enabled_modules" ? 'temu_products'
    OR "enabled_modules" ? 'temu_publish'
    OR "enabled_modules" ? 'temu_ads'
    OR "enabled_modules" ? 'temu_price'
    OR "enabled_modules" ? 'temu_purchase'
    OR "enabled_modules" ? 'temu_qc'
  );
