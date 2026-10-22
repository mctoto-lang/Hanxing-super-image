-- 商品信息页增强：goods-list 响应 bindSites（在售站点列表）落列，
-- 供商品信息页「站点」列展示（多站点拼接，如 US、EU；单站点历史列 site_name 保留）。
ALTER TABLE "temu_product" ADD COLUMN IF NOT EXISTS "site_names" text;
