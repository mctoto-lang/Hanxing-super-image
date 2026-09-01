/**
 * 穿戴图片提示词模板内置默认值
 *
 * 与 product_prompt_template 表的 weartry.* 场景一一对应：表缺行/停用时
 * 回退到这里，seed 脚本亦从此处写入初始数据（超管改表即可覆盖，无需发版）。
 *
 * 全模板化（与商品主图 V2.7 同规）：生图场景的模板填充产物即最终生图
 * prompt；可用变量见 prompt-vars.ts 注册表（管理端变量芯片同源），
 * 模板未引用的变量即不注入（严格模式）。
 */

import { PRODUCT_PROMPT_SCENES } from "@/db/schema"

export const WEARTRY_PROMPT_SCENE_LABELS: Record<string, string> = {
  "weartry.outfit_ai_write": "服装组图 · AI 帮写",
  "weartry.model_image": "模特穿戴 · 生成模特形象",
  "weartry.tryon": "模特穿戴 · 穿戴生图",
  "weartry.tryon_accessory": "AI万戴 · 穿戴生图",
  "weartry.color": "AI换色 · 换色生图",
}

/** 穿戴图片专属场景清单（product_prompt_template 表共享，按前缀分割两端配置） */
export const WEARTRY_PROMPT_SCENES = PRODUCT_PROMPT_SCENES.filter((s) =>
  s.startsWith("weartry."),
) as Array<(typeof PRODUCT_PROMPT_SCENES)[number]>

/** 商品图片专属场景清单（穿戴场景从商品配置中心隐藏，两端配置完全分割） */
export const PRODUCT_ONLY_PROMPT_SCENES = PRODUCT_PROMPT_SCENES.filter(
  (s) => !s.startsWith("weartry."),
) as Array<(typeof PRODUCT_PROMPT_SCENES)[number]>

/** AI 帮写输出的编号格式说明（与服务端 parseProductBrief 的契约一致） */
const BRIEF_FORMAT_RULES = [
  `必须严格按以下编号格式输出（编号与标题原样保留，内容写在冒号后）：`,
  `1.商品名称：简洁准确，符合服装品类命名习惯`,
  `2.核心卖点：4-6 条，每条一行并以 - 开头，不超过 12 个词，具体、可验证、突出差异化`,
  `3.适用人群：一句话`,
  `4.使用场景：一句话描述典型穿着情境`,
  `5.规格参数：2-4 条，每条一行并以 - 开头；无明确参数时写"无"`,
  `6.画面建议：一句话（材质/光感/构图）`,
  `只输出 JSON，格式：{"brief":"上述编号格式的完整文本"}`,
].join("\n")

export const WEARTRY_DEFAULT_PROMPT_TEMPLATES: Record<string, string> = {
  "weartry.outfit_ai_write": [
    `你是服装行业资深商品文案策划。分析用户提供的服装图片（如有）与补充说明，为服装组图撰写商品信息。`,
    `商品信息一律用简体中文撰写。`,
    BRIEF_FORMAT_RULES,
  ].join("\n"),
  "weartry.model_image": [
    `生成一张专业模特全身参考图（studio portrait, full body）：`,
    `- 一位 {{race}} {{age}} {{gender}} 模特，体型 {{bodyType}}，面容自然、姿态舒展站立`,
    `- 纯浅灰影棚背景，柔和均匀布光，无阴影杂物；模特穿着素色贴身打底衣裤（便于后期虚拟换装展示），赤足或素色平底鞋`,
    `- 构图：全身入镜、头顶脚底留白均衡，人物居中占画面 85% 以上`,
    `- 画面干净无文字、无水印`,
    `{{details}}`,
    `Photorealistic, high resolution, fashion model reference sheet.`,
  ].join("\n"),
  "weartry.tryon": [
    `服装虚拟试穿图：参考图最后一张是模特形象，其余参考图是待试穿服装（如有配饰一并穿戴）。让模特自然穿上该服装，生成真实上身效果图。要求：`,
    `- 服装的版型、颜色、面料质感、图案细节与参考图严格一致，不得改动设计`,
    `- 模特的脸型、发型、体型与模特形象参考图保持一致`,
    `- 合身自然：褶皱、垂坠、光影符合真实穿着物理效果`,
    `- 场景：{{sceneSegment}}`,
    `- 全身构图，人物占画面 80% 以上，五官清晰`,
    `{{details}}`,
    `{{additionalPrompt}}`,
    `Photorealistic, high resolution fashion lookbook photography.`,
  ].join("\n"),
  "weartry.tryon_accessory": [
    `配饰虚拟佩戴图：参考图最后一张是人物形象，其余参考图是待佩戴配饰（眼镜/首饰/帽子/围巾/包袋等）。让人物自然佩戴该配饰，生成真实佩戴效果图。要求：`,
    `- 配饰的材质、颜色、造型细节与参考图严格一致，比例真实（不夸张变形）`,
    `- 人物的脸型、发型、体型与人物形象参考图保持一致`,
    `- 佩戴位置自然贴合（眼镜架于鼻梁、项链落于颈间等），光影一致`,
    `- 构图：以佩戴部位为核心，必要时全身搭配视角；人物与配饰均清晰`,
    `{{details}}`,
    `{{additionalPrompt}}`,
    `Photorealistic, high resolution fashion styling photography.`,
  ].join("\n"),
  "weartry.color": [
    `服装局部换色：将图中「{{part}}」的颜色更换为 {{colorName}}（HEX {{colorHex}}，HSB {{colorHsb}}，RGB {{colorRgb}}）。要求：`,
    `- 仅更改「{{part}}」的颜色，其他区域保持原样不变`,
    `- 保留原面料质感、褶皱、印花位置、缝线与光影阴影，颜色过渡自然`,
    `- 新颜色明暗层次随原图光影变化，不得出现纯色块涂抹感`,
    `{{additionalPrompt}}`,
    `Photorealistic, high resolution.`,
  ].join("\n"),
}

/** 各场景可用变量说明（超管表单帮助文案 / 表 note 默认值） */
export const WEARTRY_PROMPT_SCENE_NOTES: Record<string, string> = {
  "weartry.outfit_ai_write":
    "变量：{{userNotes}}。商品信息固定简体中文输出；补充说明同时原文透传在 user 消息。输出需为 JSON：{\"brief\":\"编号文本块\"}",
  "weartry.model_image":
    "变量：{{gender}} {{age}} {{race}} {{bodyType}} {{details}}（模特属性补充细节）。本模板即最终生图 prompt；未引用的变量不注入。",
  "weartry.tryon":
    "变量：{{gender}} {{age}} {{race}} {{bodyType}} {{sceneKey}} {{sceneName}} {{sceneSegment}}（预置场景注入段） {{details}} {{additionalPrompt}}。本模板即最终生图 prompt；未引用的变量不注入，场景仅在被 {{sceneSegment}} 引用时生效。",
  "weartry.tryon_accessory":
    "变量：{{gender}} {{age}} {{race}} {{bodyType}} {{details}} {{additionalPrompt}}。本模板即最终生图 prompt；未引用的变量不注入。",
  "weartry.color":
    "变量：{{part}}（换色部位） {{colorName}} {{colorHex}} {{colorHsb}} {{colorRgb}} {{additionalPrompt}}（另有兼容变量 {{colorCmyk}}，由 HEX 自动派生的近似值）。本模板即最终生图 prompt；未引用的变量不注入。",
}
