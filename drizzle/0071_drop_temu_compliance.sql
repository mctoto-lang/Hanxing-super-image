-- 移除主图牛皮癣体检（用户决策：该能力仅发品场景需要，商品页下线；
-- 列为 0069 新增未发布，直接删列）。
ALTER TABLE "temu_product" DROP COLUMN IF EXISTS "compliance_spot";
ALTER TABLE "temu_product" DROP COLUMN IF EXISTS "compliance_spot_at";
