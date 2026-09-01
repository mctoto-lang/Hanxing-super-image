/**
 * 穿戴图片模板变量注册表
 *
 * 与商品主图 prompt-vars.ts 同规：本注册表是「各场景可用变量」的权威
 * 清单，超管表单变量芯片与未知变量警告共用；模板未引用的变量不注入。
 *
 * 分工：
 * - 对话场景（weartry.outfit_ai_write）：system = 模板填充产物；
 *   user 消息 = 参考图 + 用户自由文本原文透传。
 * - 生图场景（model_image/tryon/tryon_accessory/color）：模板填充产物
 *   即最终生图 prompt。
 * - 服装组图方向模板（product_direction.promptTemplate，
 *   appliesTo=["weartry"]）：buildOutfitPrompt 填充 OUTFIT_DIRECTION_VARS。
 */

import type { TemplateVarDef } from "@/lib/product/prompt-vars"

/** 模特属性类场景共用变量 */
const MODEL_ATTR_VARS: TemplateVarDef[] = [
  { name: "gender", desc: "模特性别（英文描述，如 female）" },
  { name: "age", desc: "年龄段（英文描述，如 young adult (18-28)）" },
  { name: "race", desc: "人种（英文描述，如 East Asian）" },
  { name: "bodyType", desc: "体型（英文描述，如 slim）" },
]

/** 各场景（product_prompt_template.scene = weartry.*）可用的变量 */
export const WEARTRY_SCENE_TEMPLATE_VARS: Record<string, TemplateVarDef[]> = {
  "weartry.outfit_ai_write": [
    { name: "userNotes", desc: "用户补充说明原文（同时原文透传在 user 消息中，引用会重复）" },
  ],
  "weartry.model_image": [
    ...MODEL_ATTR_VARS,
    { name: "details", desc: "模特形象补充细节（用户自由输入）" },
  ],
  "weartry.tryon": [
    ...MODEL_ATTR_VARS,
    { name: "sceneKey", desc: "预置场景 key（超管配置）" },
    { name: "sceneName", desc: "预置场景展示名（如 城市街拍）" },
    { name: "sceneSegment", desc: "预置场景注入段（weartry_scene.prompt_template 填充产物）" },
    { name: "details", desc: "模特形象补充细节（用户自由输入）" },
    { name: "additionalPrompt", desc: "用户补充要求；未引用即丢弃（严格模式）" },
  ],
  "weartry.tryon_accessory": [
    ...MODEL_ATTR_VARS,
    { name: "details", desc: "人物形象补充细节（用户自由输入）" },
    { name: "additionalPrompt", desc: "用户补充要求；未引用即丢弃（严格模式）" },
  ],
  "weartry.color": [
    { name: "part", desc: "换色部位（用户输入，如 上衣主体）" },
    { name: "colorName", desc: "颜色中文名（如 藏青；自定义色为最近色库名）" },
    { name: "colorHex", desc: "颜色 HEX 值（如 #1F2A44）" },
    { name: "colorHsb", desc: "颜色 HSB 值（如 231,55,27；h 0-360，s/b 百分比）" },
    { name: "colorRgb", desc: "颜色 RGB 值（如 31,42,68）" },
    { name: "colorCmyk", desc: "兼容变量：CMYK 值（由 HEX 自动派生的近似值；新模板建议用 {{colorHsb}}）" },
    { name: "additionalPrompt", desc: "用户补充要求；未引用即丢弃（严格模式）" },
  ],
}

/** 预置场景模板（weartry_scene.prompt_template）可用的变量 */
export const WEARTRY_SCENE_TEMPLATE_VARS_FOR_SCENE: TemplateVarDef[] = [
  { name: "sceneName", desc: "场景展示名（自身名称，可用于场景内文案）" },
  { name: "details", desc: "用户补充细节" },
]

/** 服装组图方向模板可用的变量（无平台/语言概念，比商品方向更精简） */
export const OUTFIT_DIRECTION_VARS: TemplateVarDef[] = [
  { name: "productName", desc: "服装名（AI 帮写编号块解析，可空）" },
  { name: "sellingPoints", desc: "核心卖点（编号块解析产物）" },
  { name: "topSellingPoint", desc: "首个卖点（模板大字标题常用）" },
  { name: "targetAudience", desc: "适用人群（编号块解析）" },
  { name: "additionalPrompt", desc: "用户补充要求；未引用即丢弃（严格模式）" },
]
