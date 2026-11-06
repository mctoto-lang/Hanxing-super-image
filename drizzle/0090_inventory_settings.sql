-- 0090：库存企业级设置（每企业一行）
--   restock_threshold_days：补货阈值——可售天数低于该值判定为「补货」状态（默认 14 天），
--   库存总览页按钮统一配置。
CREATE TABLE IF NOT EXISTS inventory_settings (
  enterprise_id uuid PRIMARY KEY REFERENCES enterprise(id) ON DELETE CASCADE,
  restock_threshold_days int NOT NULL DEFAULT 14,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
