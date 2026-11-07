-- 0093：物流公司偏好配置（企业级一行；自动预约发货用）
--   priority：优先顺序 jsonb 数组 [{expressCompanyId, expressCompanyName}]——自动预约比价后按序取第一个可用公司
--   blacklist：黑名单 jsonb 数组（同结构）——比价结果中剔除，不自动选择
--   编辑入口：发货单列表·待装箱发货「自动预约发货」弹窗内可折叠配置区，保存即写本表。
CREATE TABLE IF NOT EXISTS temu_logistics_config (
  enterprise_id uuid PRIMARY KEY REFERENCES enterprise(id) ON DELETE CASCADE,
  priority jsonb NOT NULL DEFAULT '[]'::jsonb,
  blacklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
