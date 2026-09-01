-- 0024: 删除套图方向池中与内置方向重复的 7 个拼音 key 方向
--
-- 背景：运营早期在超管后台手动创建的拼音 key 方向（baiditu/changjingtu/
-- maidiantu 与内置 hero_visual/usage_scene/core_selling 同名同模板，
-- duibitu/xijietu/chicuntu/zhangshitu 与 comparison/craftsmanship/
-- size_chart/multi_angle+series_display 近似重复），导致套图方向池 21 个
-- 中 7 个重复：超管配置页、用户端「自定义配置」（6 卡含 3 对同名）与
-- 智能匹配候选池均受影响。保留种子管理的 14 个内置方向（有完整升级路径）。
--
-- 历史不受影响：generation_tasks.templateInfo 存的是方向名/key 文本快照。
-- 幂等：按 key 删除，重复执行无害。

DELETE FROM product_direction WHERE key IN (
  'baiditu',    -- 重复：白底图 = hero_visual
  'changjingtu',-- 重复：场景图 = usage_scene
  'maidiantu',  -- 重复：卖点图 = core_selling
  'duibitu',    -- 重复：对比图 ≈ comparison 效果对比图
  'xijietu',    -- 重复：细节图 ≈ craftsmanship 工艺制作图
  'chicuntu',   -- 重复：尺寸图 ≈ size_chart 尺寸尺码图
  'zhangshitu'  -- 重复：展示图 ≈ multi_angle/series_display
);
