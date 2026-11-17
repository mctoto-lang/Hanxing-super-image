-- 0100：企业导航名称自定义映射 + 测试企业标记（超管在「企业管理」配置）。
--   is_test：测试企业开关，开启后侧边栏 TEMU 预设显示为「数据中心」（仅改名，无其他行为）；
--   nav_title_overrides：模块键 → 自定义导航名（空对象 = 全部用默认名；显式映射优先于测试开关预设）。
ALTER TABLE enterprise ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
ALTER TABLE enterprise ADD COLUMN IF NOT EXISTS nav_title_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;
