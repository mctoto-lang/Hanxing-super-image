/**
 * 商品主图模板变量注册表（全模板化改造 V2.7）
 *
 * 服务端不再拼接任何固定文案：用户选择与可注入内容一律以 {{变量}} 暴露，
 * 模板未引用的变量即不注入（严格模式）。本注册表是「各场景可用变量」的
 * 唯一权威清单，三处共用：超管表单变量芯片、未知变量警告、单测完整性校验。
 *
 * 注意与消息结构的分工：
 * - 对话场景（ai_write/smart_match/card_prompt）：system = 模板填充产物；
 *   user 消息 = 参考图 + 用户自由文本原文透传（无任何服务端标签）。
 * - 生图场景（replicate/方向模板）：模板填充产物即最终生图 prompt。
 */

/** 单个模板变量定义 */
export interface TemplateVarDef {
  name: string
  desc: string
}

/** 对话场景（product_prompt_template.scene）各自可用的变量 */
export const SCENE_TEMPLATE_VARS: Record<string, TemplateVarDef[]> = {
  "suite.ai_write": [
    { name: "platformKey", desc: "上架平台 key（如 amazon）" },
    { name: "platformLabel", desc: "上架平台展示名（如 亚马逊）" },
    { name: "outputLanguage", desc: "所选语言的输出语言名（如 English）；默认模板不引用=AI帮写固定简体中文" },
    { name: "userNotes", desc: "用户补充说明原文（同时原文透传在 user 消息中，引用会重复）" },
  ],
  "detail.ai_write": [
    { name: "platformKey", desc: "上架平台 key（如 amazon）" },
    { name: "platformLabel", desc: "上架平台展示名（如 亚马逊）" },
    { name: "outputLanguage", desc: "所选语言的输出语言名（如 English）；默认模板不引用=AI帮写固定简体中文" },
    { name: "userNotes", desc: "用户补充说明原文（同时原文透传在 user 消息中，引用会重复）" },
  ],
  "suite.smart_match": [
    { name: "platformKey", desc: "上架平台 key（如 amazon）" },
    { name: "platformLabel", desc: "上架平台展示名（如 亚马逊）" },
    { name: "outputLanguage", desc: "所选语言的输出语言名（copyHint 图上短文案用）" },
    { name: "productName", desc: "商品名（用户填写，可空）" },
    { name: "directionPool", desc: "可用模块池多行清单（key/名称/描述/张数上限/【主图类】标记）" },
  ],
  "suite.card_prompt": [
    { name: "platformKey", desc: "上架平台 key（如 amazon）" },
    { name: "platformLabel", desc: "上架平台展示名（如 亚马逊）" },
    { name: "outputLanguage", desc: "图内文字语言名（仅图内出现的文字用）" },
    { name: "cardCount", desc: "本次出卡的方向数量" },
    { name: "cards", desc: "编号方向清单多行文本（名称/描述/智能匹配定制指导）" },
  ],
  "replicate.level_style": [
    { name: "platformKey", desc: "上架平台 key（如 amazon）" },
    { name: "platformLabel", desc: "上架平台展示名（如 亚马逊）" },
    { name: "outputLanguage", desc: "所选语言的输出语言名" },
    { name: "platformGeneralSegment", desc: "平台通用视觉规范段（注入所有方向的那段）" },
    { name: "platformHeroSegment", desc: "平台主图规范段（原始字段值，主图类语义不再自动判定）" },
    { name: "platformSegment", desc: "平台规范段复合值（通用 + 主图两段拼接）" },
    { name: "languageDirective", desc: "图内文字语言指令（如 All text overlay … in English）" },
    { name: "additionalPrompt", desc: "用户补充要求；未引用即丢弃（严格模式）" },
  ],
  "replicate.level_strict": [
    { name: "platformKey", desc: "上架平台 key（如 amazon）" },
    { name: "platformLabel", desc: "上架平台展示名（如 亚马逊）" },
    { name: "outputLanguage", desc: "所选语言的输出语言名" },
    { name: "platformGeneralSegment", desc: "平台通用视觉规范段（注入所有方向的那段）" },
    { name: "platformHeroSegment", desc: "平台主图规范段（原始字段值，主图类语义不再自动判定）" },
    { name: "platformSegment", desc: "平台规范段复合值（通用 + 主图两段拼接）" },
    { name: "languageDirective", desc: "图内文字语言指令（如 All text overlay … in English）" },
    { name: "additionalPrompt", desc: "用户补充要求；未引用即丢弃（严格模式）" },
  ],
}

/**
 * 方向模板（product_direction.prompt_template，suite/detail/refine 共用）
 * 可用的变量。主图类语义仅作用于复合变量 {{platformSegment}}
 * （isHero 方向自动拼入平台主图规范）；细粒度变量一律为原始字段值。
 */
export const DIRECTION_TEMPLATE_VARS: TemplateVarDef[] = [
  { name: "platformKey", desc: "上架平台 key（如 amazon；refine 无平台时为空）" },
  { name: "platformLabel", desc: "上架平台展示名（如 亚马逊；refine 无平台时为空）" },
  { name: "outputLanguage", desc: "所选语言的输出语言名（refine 无语言时为空）" },
  {
    name: "platformSegment",
    desc: "平台规范段复合值：通用段 +（主图类方向）平台主图规范段",
  },
  { name: "platformGeneralSegment", desc: "平台通用视觉规范段（原始字段值）" },
  { name: "platformHeroSegment", desc: "平台主图规范段（原始字段值，不限主图类）" },
  { name: "languageDirective", desc: "图内文字语言指令（如 All text overlay … in English）" },
  { name: "productName", desc: "商品名（商品信息编号块解析）" },
  { name: "sellingPoints", desc: "核心卖点（编号块解析产物，含场景/参数等追加节）" },
  { name: "topSellingPoint", desc: "首个卖点（模板大字标题常用）" },
  { name: "targetAudience", desc: "适用人群（编号块解析）" },
  { name: "angle", desc: "智能匹配定制：机位/角度建议" },
  { name: "focus", desc: "智能匹配定制：画面主体与景别" },
  { name: "copyHint", desc: "智能匹配定制：图上短文案" },
  { name: "target", desc: "智能匹配定制：特写对象" },
  { name: "additionalPrompt", desc: "用户补充要求；未引用即丢弃（严格模式）" },
]

/** 提取模板中引用的变量名（去重保序；管理端未知变量警告与单测用） */
export function extractTemplateVars(template: string): string[] {
  const seen = new Set<string>()
  for (const m of template.matchAll(/\{\{(\w+)\}\}/g)) {
    if (!seen.has(m[1]!)) seen.add(m[1]!)
  }
  return [...seen]
}
