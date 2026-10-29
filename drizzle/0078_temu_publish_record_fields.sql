-- TEMU 发品记录增强（0078）：可观测性补全——所有失败路径（含素材图/外包装图/
-- 尺寸图上传失败等早退分支）也落记录，并在记录上补充创建人/商品名/图源三列，
-- 发品记录表格直接展示。user_id 列 0074 建表时已有（此前恒 null，本次开始写入）。
ALTER TABLE "temu_publish_record" ADD COLUMN IF NOT EXISTS "product_title" text;
ALTER TABLE "temu_publish_record" ADD COLUMN IF NOT EXISTS "image_urls" jsonb;
