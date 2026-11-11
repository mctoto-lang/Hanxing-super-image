-- 0094：TEMU 优先发货链接标记 + TEMU 域企业级配置
--   temu_priority_link：商品信息页「设置 → 设为优先发货」自建标记（官方无对应接口）。
--     同货号允许多链接标记（不排他，人工挑选利润高的链接）；备货页标记列/发货台库存参考列按
--     product_skc_id 匹配展示徽章。
--   temu_settings：滞销筛选阈值（商品信息页状态筛选「滞销」= X 天窗口日销量和 ≤ Y 件）。
--     口径仿 inventory_settings（0090/0092）：每企业一行，无行回落代码默认值。
CREATE TABLE IF NOT EXISTS temu_priority_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id uuid NOT NULL REFERENCES enterprise(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES temu_store(id) ON DELETE CASCADE,
  product_skc_id varchar(32) NOT NULL,
  product_sn varchar(64),
  product_name text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gt_temu_priority_link_uq UNIQUE (enterprise_id, store_id, product_skc_id)
);
CREATE INDEX IF NOT EXISTS gt_temu_priority_link_skc ON temu_priority_link (enterprise_id, product_skc_id);

CREATE TABLE IF NOT EXISTS temu_settings (
  enterprise_id uuid PRIMARY KEY REFERENCES enterprise(id) ON DELETE CASCADE,
  stagnant_window_days integer NOT NULL DEFAULT 30,
  stagnant_threshold_qty integer NOT NULL DEFAULT 0,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
