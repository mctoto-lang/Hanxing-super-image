-- 库存档案移除安全库存字段（0084）：低库存判定/补货建议改用销速可售天数口径
--   （有销速且 (两仓合计+在产余量)÷日均销 < 生产周期+7 天缓冲；无销速只判缺货），
--   补货建议的「安全库存阈值轨」随之移除（无销速数据不再出建议）。
-- 历史变更日志（inventory_product_log.field='safetyStock'）保留原值，展示层不再翻译。
ALTER TABLE "inventory_product" DROP COLUMN IF EXISTS "safety_stock";
