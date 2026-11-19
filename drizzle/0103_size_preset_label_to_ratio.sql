-- 0103：尺寸预设存量数据口径统一（纯比例 label → ratio）。
--   预设编辑器已切换为仅维护 ratio（{ratio,icon} 新结构），但存量行的纯比例
--   label（如 "1:1"、"16:9"）在读取侧曾优先展示，会遮蔽管理员设置的 ratio
--   （改了不生效且无从察觉）。本迁移把 label 为纯比例文案（数字:数字）的项
--   转写为该项 ratio（覆盖旧值以保持用户端可见文案不变），并移除该 label；
--   非比例自定义文案（如「智能」）的 label 原样保留。读取侧
--   （src/lib/image-sizes.ts）同步改为显式 ratio 优先、存量 label 兜底。
UPDATE "model"
   SET size_presets = (
         SELECT jsonb_agg(
                  CASE
                    WHEN elem ? 'label' AND btrim(elem->>'label') ~ '^\d+:\d+$'
                    THEN (elem - 'label') || jsonb_build_object('ratio', btrim(elem->>'label'))
                    ELSE elem
                  END
                  ORDER BY ord
                )
           FROM jsonb_array_elements(m.size_presets) WITH ORDINALITY AS t(elem, ord)
       )
  FROM "model" m
 WHERE m.id = "model".id
   AND jsonb_typeof(m.size_presets) = 'array'
   AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(m.size_presets) e
          WHERE e ? 'label' AND btrim(e->>'label') ~ '^\d+:\d+$'
       );
