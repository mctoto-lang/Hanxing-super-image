import { and, asc, eq } from "drizzle-orm"
import { db } from "@/db/client"
import {
  productLanguages,
  productPlatforms,
  productPromptTemplates,
} from "@/db/schema"
import { PLATFORMS, LANGUAGES } from "@/lib/product/dictionaries"
import {
  DEFAULT_PROMPT_TEMPLATES,
  PROMPT_SCENE_NOTES,
} from "@/lib/product/prompt-defaults"
import { fillVars } from "@/lib/product/prompt"

/**
 * 商品主图 DB 化配置解析（超管 product_* 表 → 代码常量回退）
 *
 * 约定：表空或所选 key 无活跃行时回退 dictionaries.ts 常量，
 * 系统不因配置缺失中断；提示词模板缺行回退 prompt-defaults.ts。
 */

/** 解析后的平台定义（与 dictionaries.PlatformDef 对齐） */
export interface ResolvedPlatform {
  key: string
  label: string
  heroPromptSegment?: string | null
  generalPromptSegment?: string | null
}

/** 解析后的语言定义 */
export interface ResolvedLanguage {
  key: string
  label: string
  outputName: string
  imageDirective?: string | null
}

const platformFromConstant = (key: string): ResolvedPlatform | null => {
  const hit = PLATFORMS.find((p) => p.value === key)
  if (!hit) return null
  return {
    key: hit.value,
    label: hit.label,
    heroPromptSegment: hit.heroPromptSegment ?? null,
    generalPromptSegment: hit.generalPromptSegment ?? null,
  }
}

const languageFromConstant = (key: string): ResolvedLanguage | null => {
  const hit = LANGUAGES.find((l) => l.value === key)
  if (!hit) return null
  return {
    key: hit.value,
    label: hit.label,
    outputName: hit.outputName,
    imageDirective: hit.imageDirective ?? null,
  }
}

/** 全部活跃平台（下拉数据源；表空回退常量） */
export async function listActivePlatforms(): Promise<ResolvedPlatform[]> {
  const rows = await db
    .select({
      key: productPlatforms.key,
      label: productPlatforms.label,
      heroPromptSegment: productPlatforms.heroPromptSegment,
      generalPromptSegment: productPlatforms.generalPromptSegment,
    })
    .from(productPlatforms)
    .where(eq(productPlatforms.isActive, true))
    .orderBy(asc(productPlatforms.sortOrder), asc(productPlatforms.key))
  if (rows.length === 0) {
    return PLATFORMS.map((p) => ({
      key: p.value,
      label: p.label,
      heroPromptSegment: p.heroPromptSegment ?? null,
      generalPromptSegment: p.generalPromptSegment ?? null,
    }))
  }
  return rows
}

/** 单个平台（生成链路用；无 DB 行时回退常量） */
export async function resolvePlatform(key: string): Promise<ResolvedPlatform | null> {
  const [row] = await db
    .select({
      key: productPlatforms.key,
      label: productPlatforms.label,
      heroPromptSegment: productPlatforms.heroPromptSegment,
      generalPromptSegment: productPlatforms.generalPromptSegment,
    })
    .from(productPlatforms)
    .where(
      and(eq(productPlatforms.key, key), eq(productPlatforms.isActive, true)),
    )
    .limit(1)
  return row ?? platformFromConstant(key)
}

/** 全部活跃语言（下拉数据源；表空回退常量） */
export async function listActiveLanguages(): Promise<ResolvedLanguage[]> {
  const rows = await db
    .select({
      key: productLanguages.key,
      label: productLanguages.label,
      outputName: productLanguages.outputName,
      imageDirective: productLanguages.imageDirective,
    })
    .from(productLanguages)
    .where(eq(productLanguages.isActive, true))
    .orderBy(asc(productLanguages.sortOrder), asc(productLanguages.key))
  if (rows.length === 0) {
    return LANGUAGES.map((l) => ({
      key: l.value,
      label: l.label,
      outputName: l.outputName,
      imageDirective: l.imageDirective ?? null,
    }))
  }
  return rows
}

/** 单个语言（无 DB 行时回退常量） */
export async function resolveLanguage(key: string): Promise<ResolvedLanguage | null> {
  const [row] = await db
    .select({
      key: productLanguages.key,
      label: productLanguages.label,
      outputName: productLanguages.outputName,
      imageDirective: productLanguages.imageDirective,
    })
    .from(productLanguages)
    .where(
      and(eq(productLanguages.key, key), eq(productLanguages.isActive, true)),
    )
    .limit(1)
  return row ?? languageFromConstant(key)
}

/**
 * 提示词模板（填充变量后返回；缺行/停用回退内置默认值）
 * scene 非法时返回 null（调用方报错）。
 */
export async function resolvePromptTemplate(
  scene: string,
  vars: Record<string, string | undefined> = {},
): Promise<string | null> {
  if (!(scene in DEFAULT_PROMPT_TEMPLATES)) return null
  const [row] = await db
    .select({ template: productPromptTemplates.template })
    .from(productPromptTemplates)
    .where(
      and(eq(productPromptTemplates.scene, scene), eq(productPromptTemplates.isActive, true)),
    )
    .limit(1)
  const raw = row?.template ?? DEFAULT_PROMPT_TEMPLATES[scene]!
  return fillVars(raw, vars)
}

/** 模板 note 默认值（管理端表单占位用，不发请求也可显示） */
export function promptSceneNote(scene: string): string {
  return PROMPT_SCENE_NOTES[scene] ?? ""
}
