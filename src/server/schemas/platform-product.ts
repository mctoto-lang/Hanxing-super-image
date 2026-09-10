import { z } from "zod"
import {
  PRODUCT_DIRECTION_SCOPES,
  PRODUCT_PROMPT_SCENES,
  PRODUCT_SIZE_SPEC_SCOPES,
} from "@/db/schema"

/**
 * 超管商品主图 V2 配置 zod schemas（方向池 / 平台尺寸规范）
 */

export const directionScopeSchema = z.enum(PRODUCT_DIRECTION_SCOPES)
export const sizeSpecScopeSchema = z.enum(PRODUCT_SIZE_SPEC_SCOPES)

export const createDirectionSchema = z.object({
  /** 方向标识：可不传（服务端按名称拼音自动生成）；传了仍按规则校验 */
  key: z
    .string()
    .trim()
    .min(1, "请输入方向标识")
    .max(60)
    .regex(/^[a-z0-9_]+$/, "标识仅限小写字母、数字与下划线")
    .optional(),
  name: z.string().trim().min(1, "请输入方向名称").max(100),
  description: z.string().max(200).optional(),
  promptTemplate: z.string().trim().min(1, "请输入提示词模板").max(5000),
  /** 适用子功能（单选：三个分类页配置彻底隔开，每行恰属一个作用域） */
  scope: directionScopeSchema,
  supportsCount: z.boolean(),
  maxCount: z.number().int().min(1).max(4),
  /** 顺序由列表拖拽维护；新建缺省 = 追加到末尾 */
  sortOrder: z.number().int().min(0).optional(),
  /** 前端隐藏：不出现在套图自定义配置手动列表（智能匹配/其他补充不受影响） */
  isHidden: z.boolean().default(false),
  /** 白底图类（主图）：生图时注入所选平台的 主图规范段 */
  isHero: z.boolean().default(false),
})

export const updateDirectionSchema = createDirectionSchema.partial().omit({ key: true })

export const createSizeSpecSchema = z.object({
  platformKey: z.string().trim().min(1, "请输入平台标识").max(30),
  label: z.string().trim().min(1, "请输入尺寸名称").max(100),
  width: z.number().int().min(64).max(8192),
  height: z.number().int().min(64).max(8192),
  ratioLabel: z.string().max(30).optional(),
  note: z.string().max(500).optional(),
  appliesTo: z.array(sizeSpecScopeSchema).min(1, "请至少选择一个适用子功能"),
  /** 顺序由列表拖拽维护；新建缺省 = 追加到末尾 */
  sortOrder: z.number().int().min(0).optional(),
})

export const updateSizeSpecSchema = createSizeSpecSchema.partial()

export type CreateDirectionInput = z.infer<typeof createDirectionSchema>
export type UpdateDirectionInput = z.infer<typeof updateDirectionSchema>
export type CreateSizeSpecInput = z.infer<typeof createSizeSpecSchema>
export type UpdateSizeSpecInput = z.infer<typeof updateSizeSpecSchema>

// ═══════════════ V2.1：平台 / 语言 / 提示词模板 / 展示映射 ═══════════════

const keySlug = z
  .string()
  .trim()
  .min(1, "请输入标识")
  .max(30)
  .regex(/^[a-z0-9_]+$/, "标识仅限小写字母、数字与下划线")

export const createPlatformSchema = z.object({
  key: keySlug,
  label: z.string().trim().min(1, "请输入平台名称").max(100),
  heroPromptSegment: z.string().max(2000).optional(),
  generalPromptSegment: z.string().max(2000).optional(),
  /** 顺序由列表拖拽维护；新建缺省 = 追加到末尾 */
  sortOrder: z.number().int().min(0).optional(),
})
export const updatePlatformSchema = createPlatformSchema.partial().omit({ key: true })

export const createLanguageSchema = z.object({
  key: keySlug.max(20, "语言标识最长 20"),
  label: z.string().trim().min(1, "请输入语言名称").max(100),
  outputName: z.string().trim().min(1, "请输入输出语言名").max(100),
  imageDirective: z.string().max(1000).optional(),
  /** 顺序由列表拖拽维护；新建缺省 = 追加到末尾 */
  sortOrder: z.number().int().min(0).optional(),
})
export const updateLanguageSchema = createLanguageSchema.partial().omit({ key: true })

export const promptSceneSchema = z.enum(PRODUCT_PROMPT_SCENES)
export const createPromptTemplateSchema = z.object({
  scene: promptSceneSchema,
  name: z.string().trim().min(1, "请输入模板名称").max(100),
  template: z.string().trim().min(1, "请输入提示词模板").max(8000),
  note: z.string().max(1000).optional(),
  /** 顺序由列表拖拽维护；新建缺省 = 追加到末尾 */
  sortOrder: z.number().int().min(0).optional(),
})
export const updatePromptTemplateSchema = createPromptTemplateSchema.partial().omit({
  scene: true,
})

export type CreatePlatformInput = z.infer<typeof createPlatformSchema>
export type UpdatePlatformInput = z.infer<typeof updatePlatformSchema>
export type CreateLanguageInput = z.infer<typeof createLanguageSchema>
export type UpdateLanguageInput = z.infer<typeof updateLanguageSchema>
export type CreatePromptTemplateInput = z.infer<typeof createPromptTemplateSchema>
export type UpdatePromptTemplateInput = z.infer<typeof updatePromptTemplateSchema>

// ═══════════════ AI 对话模型指定 ═══════════════

/** 商品主图 AI 指定对话模型（null = 清除指定，恢复回退逻辑） */
export const saveProductChatModelSettingSchema = z.object({
  chatApiConfigId: z.string().uuid("模型 ID 不合法").nullable(),
})
export type SaveProductChatModelSettingInput = z.infer<
  typeof saveProductChatModelSettingSchema
>
