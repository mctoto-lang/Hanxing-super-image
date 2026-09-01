import { z } from "zod"

/**
 * 超管穿戴图片主数据管理 zod schemas（预置场景）
 */

export const createSceneSchema = z.object({
  /** 缺省由名称拼音自动生成 */
  key: z.string().min(1).max(60).optional(),
  name: z.string().min(1, "请输入场景名称").max(100),
  description: z.string().max(200).optional(),
  promptTemplate: z.string().min(1, "请填写提示词模板").max(4000),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
})

export const updateSceneSchema = createSceneSchema.partial()

export type CreateSceneInput = z.infer<typeof createSceneSchema>
export type UpdateSceneInput = z.infer<typeof updateSceneSchema>
