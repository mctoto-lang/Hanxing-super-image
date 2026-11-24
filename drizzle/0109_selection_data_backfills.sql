-- 0109：选品数据回填（2026-11-24，R-8-1 / R-8-2 / R-8-7 / R-9-6 四项共用 + Amazon 评论点赞回补）
--   1. TEMU 市场搜索 / 销量榜行：price 与 market_price 落库时被当「元」，实际是「分」
--      （$1.21 存成 121.00）。按 raw_data 的 price_str / market_price_str（元文本）
--      重算；无字符串时分数值 / 100；market_price 不大于 price 时划线价置 NULL。
--      限 task_type in ('market','discover')——监控单品详情 actor 的 price 本就是元。
--   2. Etsy 市场搜索行：discount_price 是带 $ 的字符串（"$53.99"），从未生效。
--      从 raw_data 重算 price（折扣价）与 original_price（原价）。
--   3. Etsy 评论：published_at 全空，从 raw_data.reviewDateIso（"2026-11-15"）回补。
--   4. Amazon 行币种符号归一：$ / £ / € → USD / GBP / EUR（换 junglee 前的旧行，
--      与新行的 ISO 码合并，KPI「均价」不再按符号分裂成两组）。
--   5. Amazon 评论：likes_count 从 raw_data.reviewReaction（字符串数字）回补。
-- 全部幂等（IS DISTINCT FROM / IS NULL / 符号清零后不再匹配），不涉及枚举字面量；
-- 语句按编号顺序执行（第 1 段先修 price 再算 original_price 的比较基准）。
UPDATE "selection_result"
SET "price" = regexp_replace(raw_data->>'price_str', '[^0-9.]', '', 'g')::numeric
WHERE "platform" = 'temu'
  AND "task_type" IN ('market', 'discover')
  AND regexp_replace(raw_data->>'price_str', '[^0-9.]', '', 'g') ~ '^[0-9]+(\.[0-9]+)?$'
  AND "price" IS DISTINCT FROM regexp_replace(raw_data->>'price_str', '[^0-9.]', '', 'g')::numeric;--> statement-breakpoint
UPDATE "selection_result"
SET "price" = (raw_data->>'price')::numeric / 100
WHERE "platform" = 'temu'
  AND "task_type" IN ('market', 'discover')
  AND coalesce(regexp_replace(raw_data->>'price_str', '[^0-9.]', '', 'g'), '') !~ '^[0-9]+(\.[0-9]+)?$'
  AND (raw_data->>'price') ~ '^[0-9]+(\.[0-9]+)?$'
  AND "price" IS NOT DISTINCT FROM (raw_data->>'price')::numeric;--> statement-breakpoint
UPDATE "selection_result"
SET "original_price" = CASE
  WHEN regexp_replace(raw_data->>'market_price_str', '[^0-9.]', '', 'g')::numeric > "price"
  THEN regexp_replace(raw_data->>'market_price_str', '[^0-9.]', '', 'g')::numeric
  ELSE NULL
END
WHERE "platform" = 'temu'
  AND "task_type" IN ('market', 'discover')
  AND regexp_replace(raw_data->>'market_price_str', '[^0-9.]', '', 'g') ~ '^[0-9]+(\.[0-9]+)?$'
  AND "original_price" IS DISTINCT FROM (
    CASE
      WHEN regexp_replace(raw_data->>'market_price_str', '[^0-9.]', '', 'g')::numeric > "price"
      THEN regexp_replace(raw_data->>'market_price_str', '[^0-9.]', '', 'g')::numeric
    END
  );--> statement-breakpoint
UPDATE "selection_result"
SET "original_price" = CASE
  WHEN (raw_data->>'market_price')::numeric / 100 > "price"
  THEN (raw_data->>'market_price')::numeric / 100
  ELSE NULL
END
WHERE "platform" = 'temu'
  AND "task_type" IN ('market', 'discover')
  AND coalesce(regexp_replace(raw_data->>'market_price_str', '[^0-9.]', '', 'g'), '') !~ '^[0-9]+(\.[0-9]+)?$'
  AND (raw_data->>'market_price') ~ '^[0-9]+(\.[0-9]+)?$'
  AND "original_price" IS DISTINCT FROM (
    CASE
      WHEN (raw_data->>'market_price')::numeric / 100 > "price"
      THEN (raw_data->>'market_price')::numeric / 100
    END
  );--> statement-breakpoint
WITH etsy AS (
  SELECT r.id,
    regexp_replace(r.raw_data->>'discount_price', '[^0-9.]', '', 'g')::numeric AS disc,
    coalesce(
      nullif(r.raw_data->>'price_num', '')::numeric,
      nullif(r.raw_data->>'price_int', '')::numeric,
      nullif(r.raw_data->>'price', '')::numeric
    ) AS orig
  FROM "selection_result" r
  WHERE r."platform" = 'etsy'
    AND r."task_type" = 'market'
    AND regexp_replace(r.raw_data->>'discount_price', '[^0-9.]', '', 'g') ~ '^[0-9]+(\.[0-9]+)?$'
    AND coalesce(
      nullif(r.raw_data->>'price_num', '')::numeric,
      nullif(r.raw_data->>'price_int', '')::numeric,
      nullif(r.raw_data->>'price', '')::numeric
    ) IS NOT NULL
)
UPDATE "selection_result" r
SET "price" = least(e.disc, e.orig),
    "original_price" = CASE WHEN e.disc < e.orig THEN e.orig ELSE NULL END
FROM etsy e
WHERE r.id = e.id
  AND (r."price", r."original_price") IS DISTINCT FROM (
    least(e.disc, e.orig),
    CASE WHEN e.disc < e.orig THEN e.orig ELSE NULL END
  );--> statement-breakpoint
UPDATE "selection_review"
SET "published_at" = (raw_data->>'reviewDateIso')::date
WHERE "platform" = 'etsy'
  AND "published_at" IS NULL
  AND raw_data->>'reviewDateIso' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';--> statement-breakpoint
UPDATE "selection_result"
SET "currency" = CASE "currency"
  WHEN '$' THEN 'USD'
  WHEN '£' THEN 'GBP'
  WHEN '€' THEN 'EUR'
END
WHERE "platform" = 'amazon'
  AND "currency" IN ('$', '£', '€');--> statement-breakpoint
UPDATE "selection_review"
SET "likes_count" = (raw_data->>'reviewReaction')::integer
WHERE "platform" = 'amazon'
  AND "likes_count" IS NULL
  AND (raw_data->>'reviewReaction') ~ '^[0-9]{1,9}$';
