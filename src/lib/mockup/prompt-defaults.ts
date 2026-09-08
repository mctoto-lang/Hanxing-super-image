/**
 * 样机渲染提示词模板内置默认值
 *
 * 与 product_prompt_template 表的 mockup.* 场景一一对应：表缺行/停用时
 * 回退到这里。模板填充产物即最终生图 prompt（参考图 = 当前渲染完成的
 * 样机图，由服务端注入，模板无需变量）。
 */

import { PRODUCT_PROMPT_SCENES } from "@/db/schema"

export const MOCKUP_PROMPT_SCENE_LABELS: Record<string, string> = {
  "mockup.ai_background": "AI背景 · 生成样机背景图",
}

/** 样机渲染专属场景清单（product_prompt_template 表共享，按前缀分割各端配置） */
export const MOCKUP_PROMPT_SCENES = PRODUCT_PROMPT_SCENES.filter((s) =>
  s.startsWith("mockup."),
) as Array<(typeof PRODUCT_PROMPT_SCENES)[number]>

export const MOCKUP_DEFAULT_PROMPT_TEMPLATES: Record<string, string> = {
  "mockup.ai_background": [
    `基于参考图（样机渲染图）的画面内容与整体风格，生成一张用于替换样机背景图层的环境背景图：`,
    `- 背景与参考图中的产品/主体气质协调，光影方向与色温自然衔接`,
    `- 构图简洁、不喧宾夺主，为主体预留干净的视觉区域，避免复杂纹理干扰主体展示`,
    `- 高分辨率、细节真实，画面中不出现文字与水印`,
    `Photorealistic, high resolution, clean composition.`,
  ].join("\n"),
}

/** 各场景可用变量说明（超管表单帮助文案 / 表 note 默认值） */
export const MOCKUP_PROMPT_SCENE_NOTES: Record<string, string> = {
  "mockup.ai_background":
    "无变量，本模板即最终生图 prompt；参考图固定为该样机当前渲染完成的图片，由系统自动注入。",
}
