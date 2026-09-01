/**
 * 穿戴图片 prompt 组装（纯函数，供 "use server" actions 与单测复用）
 *
 * 全模板化（与商品主图 V2.7 同规）：输出 = fillVars(模板, 全量变量)，
 * 服务端不追加任何固定文案；模板未引用的变量即不注入（严格模式）。
 */

import { fillVars } from "@/lib/product/prompt"
import {
  modelAttrHelpers,
  type RecentColorEntry,
} from "@/lib/weartry/dictionaries"

/** 模特形象属性（提交值 → prompt 变量） */
export interface ModelAttrInput {
  gender?: string
  age?: string
  race?: string
  bodyType?: string
}

function attrVars(attrs: ModelAttrInput): Record<string, string | undefined> {
  return {
    gender: modelAttrHelpers.gender(attrs.gender ?? "")?.promptWord,
    age: modelAttrHelpers.age(attrs.age ?? "")?.promptWord,
    race: modelAttrHelpers.race(attrs.race ?? "")?.promptWord,
    bodyType: modelAttrHelpers.bodyType(attrs.bodyType ?? "")?.promptWord,
  }
}

/**
 * 服装组图方向 prompt 组装（buildDirectionPrompt 的穿戴精简版：
 * 无平台/语言/智能匹配概念）
 */
export function buildOutfitPrompt(opts: {
  promptTemplate: string
  baseVars: Record<string, string | undefined>
  additionalPrompt?: string
}): string {
  return fillVars(opts.promptTemplate, {
    ...opts.baseVars,
    additionalPrompt: opts.additionalPrompt?.trim() || undefined,
  })
}

/**
 * 模特形象 prompt（scene="weartry.model_image"）
 *
 * attrs 的四个属性下拉值经字典映射为英文描述注入。
 */
export function buildModelImagePrompt(opts: {
  template: string
  attrs: ModelAttrInput
  details?: string
}): string {
  return fillVars(opts.template, {
    ...attrVars(opts.attrs),
    details: opts.details?.trim() || undefined,
  })
}

/**
 * 穿戴图 prompt（scene="weartry.tryon" / "weartry.tryon_accessory"）
 *
 * 场景注入：scene.promptTemplate 先以基础变量填充为 {{sceneSegment}}，
 * 主模板引用该复合变量才生效（场景相关细粒度变量 sceneKey/sceneName
 * 同时提供，超管可自行取舍）。
 */
export function buildTryonPrompt(opts: {
  template: string
  attrs: ModelAttrInput
  details?: string
  additionalPrompt?: string
  scene?: {
    key?: string
    name?: string
    promptTemplate?: string
  } | null
}): string {
  const base: Record<string, string | undefined> = {
    ...attrVars(opts.attrs),
    details: opts.details?.trim() || undefined,
    additionalPrompt: opts.additionalPrompt?.trim() || undefined,
    // 场景自身信息（场景模板可引用 {{sceneName}}，主模板亦可细粒度取值）
    sceneKey: opts.scene?.key,
    sceneName: opts.scene?.name,
  }
  const sceneSegment = opts.scene?.promptTemplate
    ? fillVars(opts.scene.promptTemplate, base)
    : undefined
  return fillVars(opts.template, {
    ...base,
    sceneSegment,
  })
}

/** 换色 prompt（scene="weartry.color"）；色值见 dictionaries/convert 的字段 */
export function buildColorPrompt(opts: {
  template: string
  part: string
  colorName: string
  colorHex: string
  colorHsb: string
  colorRgb: string
  additionalPrompt?: string
  /** 兼容变量：旧模板 {{colorCmyk}}（服务端由 HEX 派生，新模板无需引用） */
  colorCmyk?: string
}): string {
  return fillVars(opts.template, {
    part: opts.part.trim() || undefined,
    colorName: opts.colorName,
    colorHex: opts.colorHex,
    colorHsb: opts.colorHsb,
    colorCmyk: opts.colorCmyk,
    colorRgb: opts.colorRgb,
    additionalPrompt: opts.additionalPrompt?.trim() || undefined,
  })
}

/**
 * 最近使用颜色（浏览器本地缓存）读写：
 * 新色去重后插入队首，仅保留最近 RECENT_COLORS_MAX 条。
 */
export function pushRecentColor(
  list: RecentColorEntry[],
  entry: Omit<RecentColorEntry, "savedAt">,
  max = 5,
): RecentColorEntry[] {
  const rest = list.filter((c) => c.hex.toUpperCase() !== entry.hex.toUpperCase())
  return [{ ...entry, savedAt: Date.now() }, ...rest].slice(0, max)
}
