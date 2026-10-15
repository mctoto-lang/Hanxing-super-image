-- 即梦参考图出站字段对齐 jimeng-free-api 反代：反代 /v1/images/generations
-- 只解析 filePath/filePaths 参考图字段，images 会被静默忽略（按纯文生图出图）。
-- 存量即梦模型中等于旧默认值 images 的行改为 filePaths；自定义字段名保持不动。
UPDATE "model"
SET "reference_image_field" = 'filePaths'
WHERE "api_format" = 'jimeng' AND "reference_image_field" = 'images';

-- 列默认值 'images' 与读取端按格式分默认的口径不一致（openai→image、
-- 即梦→filePaths、grsai 不读该列）：显式写 NULL 时各格式自然落到自己的
-- 默认，而列级默认会让绕过表单 action 的 INSERT 给即梦模型填回 images
-- （非空值会绕过代码默认），故直接去掉列级默认。
ALTER TABLE "model" ALTER COLUMN "reference_image_field" DROP DEFAULT;
