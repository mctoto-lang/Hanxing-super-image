-- 0102：生图接口格式规范化为六格式。
--   api_format 新增 chat（Chat 协议：OpenAI 兼容对话接口生图，参考图走多模态消息、
--   从回复解析图片）与 midjourney（MJ Proxy 协议，aipaiai：/mj/submit/imagine 提交 +
--   /mj/task/{id}/fetch 轮询，一次任务固定 4 张四宫格）。
--   旧 gemini 行（Gemini 系中转，请求形状同 openai）整体搬迁为 openai（Images 协议：
--   generations/edits 按有无参考图分流），其比例行为改由 extraConfig.sizeMode='ratio'
--   承载——搬迁前对 use_ratio_param=true 且 extraConfig 尚无 sizeMode 的行补写
--   "ratio"，保证行为不变；此后枚举值 gemini 专指 Gemini 官方原生协议
--   （:generateContent + responseModalities IMAGE + imageConfig.aspectRatio 比例生图）。
ALTER TYPE "public"."api_format" ADD VALUE IF NOT EXISTS 'chat';--> statement-breakpoint
ALTER TYPE "public"."api_format" ADD VALUE IF NOT EXISTS 'midjourney';--> statement-breakpoint
UPDATE "model"
   SET extra_config = jsonb_set(COALESCE(extra_config, '{}'::jsonb), '{sizeMode}', '"ratio"'::jsonb)
 WHERE api_format = 'gemini'
   AND use_ratio_param = true
   AND NOT COALESCE(extra_config, '{}'::jsonb) ? 'sizeMode';--> statement-breakpoint
UPDATE "model" SET api_format = 'openai' WHERE api_format = 'gemini';
