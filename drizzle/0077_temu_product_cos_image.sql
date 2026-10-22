-- TEMU 商品主图转存 COS（0077）：同步落库的商品主图（kwcdn 外链）增量转存到
-- COS/本地存储（storage 统一适配器，category=temu），供前端稳定展示；
-- 缩略图复用同一对象 + 数据万象 imageMogr2 缩放参数。
-- main_image_cos_source 记录转存时的源 URL：主图换图（与现 main_image_url
-- 不一致）时下一轮同步触发重转存。
ALTER TABLE "temu_product" ADD COLUMN IF NOT EXISTS "main_image_cos_url" text;
ALTER TABLE "temu_product" ADD COLUMN IF NOT EXISTS "main_image_cos_source" text;
