-- 0097：TEMU 多应用（多主体）模型 + 演示店铺标记
--   temu_app：每企业可配置多个官方开放平台自研应用（各主体一套 app_key/secret），
--     店铺挂到应用下、单应用最多 20 店铺；调用凭证按「店铺 → 应用」取。
--   temu_store.app_id / is_demo：店铺归属应用；is_demo=true 为演示店铺（企业未配置
--     任何 TEMU 应用时自动创建，走官方沙箱凭证，配置真实应用后自动清理）。
--   数据搬迁：system_setting(key='temu_api_app') 每企业一行 → temu_app「默认应用」，
--     店铺回填 app_id，随后删除 system_setting 旧行（app-config 读写通路同步删除）。
--     一次性搬迁，生产执行前必须 pg_dump（回滚不能只回代码）。
CREATE TABLE IF NOT EXISTS temu_app (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id uuid NOT NULL REFERENCES enterprise(id) ON DELETE CASCADE,
  name varchar(100) NOT NULL,
  app_key varchar(64) NOT NULL DEFAULT '',
  app_secret_encrypted text NOT NULL DEFAULT '',
  test_mode boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gt_temu_app_ent ON temu_app (enterprise_id);
--> statement-breakpoint
ALTER TABLE temu_store ADD COLUMN app_id uuid REFERENCES temu_app(id);
--> statement-breakpoint
ALTER TABLE temu_store ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS gt_temu_store_app ON temu_store (app_id);
--> statement-breakpoint
-- 搬迁：企业级凭证行 → 默认应用（保留 app_key/密文/test_mode 原值）
INSERT INTO temu_app (enterprise_id, name, app_key, app_secret_encrypted, test_mode, sort_order)
SELECT ss.enterprise_id,
       '默认应用',
       COALESCE(ss.value->>'appKey', ''),
       COALESCE(ss.value->>'appSecretEncrypted', ''),
       COALESCE((ss.value->>'testMode')::boolean, false),
       0
FROM system_setting ss
WHERE ss.key = 'temu_api_app' AND ss.enterprise_id IS NOT NULL;
--> statement-breakpoint
-- 店铺回填 app_id（同企业全部店铺挂到该企业的默认应用）
UPDATE temu_store ts
SET app_id = ta.id
FROM temu_app ta
WHERE ta.enterprise_id = ts.enterprise_id
  AND ts.app_id IS NULL
  AND ts.is_demo = false;
--> statement-breakpoint
-- 删除旧通路行（getTemuAppSettingAction/saveTemuAppSettingAction 已被 temu_app CRUD 取代）
DELETE FROM system_setting WHERE key = 'temu_api_app';
