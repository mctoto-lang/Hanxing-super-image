-- 0095：生成图转存时探测像素尺寸落库
--   generation_task.result_image_sizes：与 result_images 按位置一一对应的
--   [{width,height}|null] 数组（worker 转存顺带探测；null=本桶复用/未知格式/
--   存量未回填），供图片过期后的占位框与加载前骨架使用真实宽高比。

ALTER TABLE generation_task ADD COLUMN IF NOT EXISTS result_image_sizes jsonb;
