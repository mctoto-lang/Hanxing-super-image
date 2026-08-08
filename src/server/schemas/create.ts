import { z } from "zod"

/**
 * 创作页 zod schemas（手册 M3）
 */

export const submitTaskSchema = z.object({
  modelId: z.string().uuid("请选择模型"),
  prompt: z
    .string()
    .min(1, "请输入提示词")
    .max(4000, "提示词过长（上限 4000 字符）"),
  imageSize: z
    .string()
    .min(1, "请选择尺寸")
    .max(30),
  imageCount: z.number().int().min(1).max(4).optional(),
  referenceImages: z.array(z.string().url()).max(5).optional(),
})

export type SubmitTaskInput = z.infer<typeof submitTaskSchema>
