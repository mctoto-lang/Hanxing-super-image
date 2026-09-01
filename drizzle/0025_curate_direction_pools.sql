-- 0025: 方向池重构——商品套图精选 5 个，其余模块能力由 A+详情页全量 14 模块承接
--
-- 1) 删除套图池 9 个方向（效果对比/品牌故事/工艺制作/规格参数/配件/系列/
--    成分/售后/使用建议）：套图仅保留 白底图/卖点图/场景图/多角度图/尺寸尺码图；
--    被删模块在 A+详情页方向池有对应模块（0025 同批种入/重命名）。
-- 2) 多角度图与尺寸尺码图取消前端隐藏：精选池 5 个全部在「自定义配置」可见。
--
-- 幂等：按 key 操作，重复执行无害。

DELETE FROM product_direction WHERE key IN (
  'brand_story',     -- 品牌故事图 → A+ 品牌故事图
  'comparison',      -- 效果对比图 → A+ 效果对比图
  'craftsmanship',   -- 工艺制作图 → A+ 工艺制作图
  'spec_table',      -- 规格参数表 → A+ 规格/参数表
  'accessories',     -- 配件-赠品图 → A+ 配件-赠品图
  'series_display',  -- 系列展示图 → A+ 系列展示图
  'ingredients',     -- 商品成分图 → A+ 商品成分图
  'after_sales',     -- 售后保障图 → A+ 售后保障图
  'usage_tips'       -- 使用建议图 → A+ 使用建议图
);

UPDATE product_direction
SET is_hidden = false, updated_at = now()
WHERE key IN ('multi_angle', 'size_chart') AND is_hidden;
