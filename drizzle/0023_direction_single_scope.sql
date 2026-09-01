-- 0023: 图片方向作用域单选化（商品套图/A+详情页/产品精修 配置彻底隔开）
--
-- 背景：applies_to 原为多选数组，一个方向可同时归属多个二级分类，
-- 三个分类页出现重复卡片且编辑互相影响。改为每行恰好一个作用域：
-- 1) 多作用域行拆分：第 2+ 个作用域克隆为独立行（key 追加作用域后缀）；
-- 2) 原行收窄为首个作用域；空数组兜底为 suite；
-- 3) 列默认值改为 ["suite"]，并加单作用域 CHECK 约束。

-- 1) 拆分：克隆第 2+ 个作用域（key 冲突时跳过该克隆，极罕见）
INSERT INTO product_direction (
  key, name, description, prompt_template, applies_to, supports_count,
  max_count, sort_order, is_active, is_hidden, is_hero
)
SELECT
  left(d.key, 60 - length(s.scope) - 1) || '_' || s.scope,
  d.name, d.description, d.prompt_template,
  jsonb_build_array(s.scope),
  d.supports_count, d.max_count, d.sort_order,
  d.is_active, d.is_hidden, d.is_hero
FROM product_direction d,
     jsonb_array_elements_text(d.applies_to) WITH ORDINALITY AS s(scope, ord)
WHERE jsonb_array_length(d.applies_to) > 1
  AND s.ord > 1
ON CONFLICT (key) DO NOTHING;

-- 2) 原行收窄为首个作用域；空数组兜底
UPDATE product_direction
SET applies_to = jsonb_build_array(applies_to->>0)
WHERE jsonb_array_length(applies_to) > 1;

UPDATE product_direction
SET applies_to = '["suite"]'::jsonb
WHERE jsonb_array_length(applies_to) = 0;

-- 3) 默认值 + 单作用域约束（幂等：可安全重放）
ALTER TABLE product_direction
  ALTER COLUMN applies_to SET DEFAULT '["suite"]'::jsonb;

ALTER TABLE product_direction
  DROP CONSTRAINT IF EXISTS pd_single_scope_check;

ALTER TABLE product_direction
  ADD CONSTRAINT pd_single_scope_check CHECK (jsonb_array_length(applies_to) = 1);
