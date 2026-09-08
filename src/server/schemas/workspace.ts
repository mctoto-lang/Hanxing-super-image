import { z } from "zod"

/**
 * 工作台 Server Actions 入参校验（写操作）。
 *
 * 此前 workspace.ts 的 41 个 action 均无 Zod 校验，仅零散手工钳制——
 * cardCount / prompts 数组长度 / size 等无上限，构成资源滥用面。本文件
 * 为全部写操作补齐边界（上限与前端约束、创作页 submitTaskSchema 对齐：
 * 提示词 4000、标题 200）。校验仅拒绝越界入参，函数体继续使用原入参
 * （通过校验后即保证在界内）。
 */

/** 通用 id（taskId/cardId/templateId/apiId/imageId） */
export const wsIdSchema = z.string().min(1).max(64)

/** 卡片 id 批量上限（单次批量操作规模） */
export const wsCardIdsSchema = z.array(wsIdSchema).min(1).max(200)

const promptSchema = z
  .string()
  .min(1, "提示词不能为空")
  .max(4000, "提示词过长（上限 4000 字符）")

const titleSchema = z
  .string()
  .trim()
  .min(1, "标题不能为空")
  .max(200, "标题过长（上限 200 字符）")

const sizeSchema = z
  .string()
  .regex(/^\d{2,5}x\d{2,5}$/, "尺寸格式非法（应为 WxH）")

const languagePreferenceSchema = z.enum(["zh", "en"])

const templateTypeSchema = z.enum([
  "fission",
  "deepen",
  "regenerate",
  "extract",
  "translate",
])

export const createWorkspaceTaskSchema = z.object({
  mode: z.enum(["smart", "extract", "custom"]).optional(),
  theme: z.string().max(500, "主题描述过长").optional(),
  cardCount: z.number().int().min(1).max(200).optional(),
  templateId: wsIdSchema.optional(),
  prompts: z.array(promptSchema).max(200).optional(),
  title: titleSchema.optional(),
  referenceImages: z.array(z.string().max(2048)).max(10).optional(),
})

export const updateTaskTitleSchema = z.object({ title: titleSchema })

export const addCardSchema = z.object({ prompt: promptSchema })

export const updateCardSchema = z.object({
  prompt: promptSchema.optional(),
  displayLanguage: z.enum(["zh", "en"]).optional(),
})

/** 深化/重生成（卡片单张）：prompt + 模板 */
export const cardPromptTemplateSchema = z.object({
  prompt: promptSchema,
  templateId: wsIdSchema,
})

/** 翻译（卡片单张）/ 批量模板类操作 */
export const templateOnlySchema = z.object({ templateId: wsIdSchema })

export const batchReplacePromptsSchema = z.object({
  selectedCardIds: z.array(wsIdSchema).max(200),
  items: z
    .array(
      z.object({
        cardIndex: z.number().int().min(0).max(10_000),
        prompt: z.string().min(1).max(8000, "提示词过长"),
      }),
    )
    .max(200),
})

export const extractNumberedPromptsSchema = z.object({
  templateId: wsIdSchema,
  input: z.string().min(1, "待提取内容不能为空").max(100_000, "内容过长"),
})

export const generateCardImageSchema = z.object({
  prompt: promptSchema,
  apiId: wsIdSchema,
  size: sizeSchema,
})

export const batchGenerateImageSchema = z.object({
  apiId: wsIdSchema,
  size: sizeSchema,
  languagePreference: languagePreferenceSchema.optional(),
})

export const updateCardReferenceImagesSchema = z.object({
  apiId: wsIdSchema,
  referenceImages: z.array(z.string().max(2048)).max(20),
})

export const addUploadedCardImageSchema = z.object({
  imageUrl: z.string().min(1, "图片地址无效").max(2048),
})

/** 批量绑定上传图：URL 数量上限（与单卡参考图上限同量级放大） */
export const batchAttachUrlsSchema = z
  .array(z.string().max(2048))
  .max(50, "单次绑定图片数量过多")

export const createTemplateSchema = z.object({
  type: templateTypeSchema,
  name: z.string().trim().min(1, "模板名不能为空").max(100, "模板名过长"),
  content: z.string().min(1, "模板内容不能为空").max(20_000, "模板内容过长"),
  chatApiId: wsIdSchema,
  fissionCount: z.number().int().min(0).max(100).nullable().optional(),
  visibility: z.enum(["private", "public"]),
})

export const updateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  content: z.string().min(1).max(20_000).optional(),
  chatApiId: wsIdSchema.optional(),
  fissionCount: z.number().int().min(0).max(100).nullable().optional(),
  visibility: z.enum(["private", "public"]).optional(),
})
