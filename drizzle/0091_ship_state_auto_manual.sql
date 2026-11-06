-- 0091：发货状态语义替换 normal/stopped → auto/manual
--   auto=自动发货：库存联动自动扣减；后续规划的「一键自动备货发货」只处理该状态货号
--   manual=手动发货：装箱发货照常自动扣库存，但自动化功能不对该货号执行
--   旧 stopped（停止发货）数据语义迁移为 manual（人工跟进）；装箱弹窗的停止发货二次确认随旧语义移除。
-- 幂等：RENAME VALUE 不可重复执行，按 pg_enum 存在性条件跳过；改名后旧默认值 'normal'
--   失效，同迁移把默认值改为 'auto'。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'inventory_ship_state' AND e.enumlabel = 'normal'
  ) THEN
    EXECUTE 'ALTER TYPE inventory_ship_state RENAME VALUE ''normal'' TO ''auto''';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'inventory_ship_state' AND e.enumlabel = 'stopped'
  ) THEN
    EXECUTE 'ALTER TYPE inventory_ship_state RENAME VALUE ''stopped'' TO ''manual''';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE inventory_product ALTER COLUMN ship_state SET DEFAULT 'auto';
