import { and, asc, eq } from "drizzle-orm"
import { db } from "@/db/client"
import { productPromptTemplates, weartryScenes } from "@/db/schema"
import { fillVars } from "@/lib/product/prompt"
import {
  WEARTRY_DEFAULT_PROMPT_TEMPLATES,
  WEARTRY_PROMPT_SCENE_NOTES,
} from "@/lib/weartry/prompt-defaults"

/**
 * 穿戴图片 DB 化配置解析（weartry_scene 表 + product_prompt_template 的
 * weartry.* 场景 → 代码常量回退），与商品主图 product-config.ts 同规：
 * 表空或所选 key 无活跃行时回退内置默认，系统不因配置缺失中断。
 */

/** 解析后的预置场景（生成链路用；promptTemplate 未填充即注入段原文） */
export interface ResolvedWeartryScene {
  key: string
  name: string
  description?: string | null
  promptTemplate: string
}

/** 全部活跃场景（下拉数据源） */
export async function listActiveWeartryScenes(): Promise<
  Array<ResolvedWeartryScene>
> {
  return db
    .select({
      key: weartryScenes.key,
      name: weartryScenes.name,
      description: weartryScenes.description,
      promptTemplate: weartryScenes.promptTemplate,
    })
    .from(weartryScenes)
    .where(eq(weartryScenes.isActive, true))
    .orderBy(asc(weartryScenes.sortOrder), asc(weartryScenes.key))
}

/** 单个场景（生成链路用） */
export async function resolveWeartryScene(
  key: string,
): Promise<ResolvedWeartryScene | null> {
  const [row] = await db
    .select({
      key: weartryScenes.key,
      name: weartryScenes.name,
      description: weartryScenes.description,
      promptTemplate: weartryScenes.promptTemplate,
    })
    .from(weartryScenes)
    .where(and(eq(weartryScenes.key, key), eq(weartryScenes.isActive, true)))
    .limit(1)
  return row ?? null
}

/**
 * 穿戴提示词模板原始正文（DB 活跃行 → 回退内置默认；不填充变量）。
 * scene 非法时返回 null。生成链路用它 + lib/weartry/prompt.ts 的
 * 纯函数组装（场景注入段等复合逻辑在纯函数内，可单测）。
 */
export async function loadWeartryPromptTemplate(
  scene: string,
): Promise<string | null> {
  if (!(scene in WEARTRY_DEFAULT_PROMPT_TEMPLATES)) return null
  const [row] = await db
    .select({ template: productPromptTemplates.template })
    .from(productPromptTemplates)
    .where(
      and(
        eq(productPromptTemplates.scene, scene),
        eq(productPromptTemplates.isActive, true),
      ),
    )
    .limit(1)
  return row?.template ?? WEARTRY_DEFAULT_PROMPT_TEMPLATES[scene]!
}

/**
 * 穿戴提示词模板（填充变量后返回；缺行/停用回退内置默认值）。
 * scene 非法时返回 null（调用方报错）。
 */
export async function resolveWeartryPromptTemplate(
  scene: string,
  vars: Record<string, string | undefined> = {},
): Promise<string | null> {
  if (!(scene in WEARTRY_DEFAULT_PROMPT_TEMPLATES)) return null
  const [row] = await db
    .select({ template: productPromptTemplates.template })
    .from(productPromptTemplates)
    .where(
      and(
        eq(productPromptTemplates.scene, scene),
        eq(productPromptTemplates.isActive, true),
      ),
    )
    .limit(1)
  const raw = row?.template ?? WEARTRY_DEFAULT_PROMPT_TEMPLATES[scene]!
  return fillVars(raw, vars)
}

/** 模板 note 默认值（管理端表单占位用，不发请求也可显示） */
export function weartryPromptSceneNote(scene: string): string {
  return WEARTRY_PROMPT_SCENE_NOTES[scene] ?? ""
}
