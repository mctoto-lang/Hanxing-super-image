-- 0098：TEMU 停止补货链接标记（官方无对应接口，纯本地标记，口径仿 0094 优先发货）。
--   商品信息页「设置 → 设为停止补货」；备货页标记列红徽章；自动申报备货/批量加入发货
--   两弹窗内该链接行置顶禁选（可申报上限/库存核对列徽标提示），主表手动操作不受影响。
CREATE TABLE IF NOT EXISTS temu_stop_replenish_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id uuid NOT NULL REFERENCES enterprise(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES temu_store(id) ON DELETE CASCADE,
  product_skc_id varchar(32) NOT NULL,
  product_sn varchar(64),
  product_name text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gt_temu_stop_replenish_link_uq UNIQUE (enterprise_id, store_id, product_skc_id)
);
CREATE INDEX IF NOT EXISTS gt_temu_stop_replenish_link_skc ON temu_stop_replenish_link (enterprise_id, product_skc_id);
