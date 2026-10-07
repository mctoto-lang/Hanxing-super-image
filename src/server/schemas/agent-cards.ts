import { z } from "zod"

export const updateCardPlanItemSchema = z.object({
  runId: z.string().uuid(),
  itemId: z.string().uuid(),
  meaning: z.string().trim().min(1).max(2000),
  visualBrief: z.string().trim().min(1).max(4000),
})

export const confirmCardPlanSchema = z.object({ runId: z.string().uuid() })

/** 重新生成卡面提示词：itemIds 缺省 = 全部 78 张；feedback 为可选改写要求 */
export const regenerateCardPromptsSchema = z.object({
  runId: z.string().uuid(),
  itemIds: z.array(z.string().uuid()).min(1).max(78).optional(),
  feedback: z.string().trim().max(2000).optional(),
})
