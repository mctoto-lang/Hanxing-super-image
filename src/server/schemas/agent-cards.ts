import { z } from "zod"

export const cardPlanQuerySchema = z.object({ runId: z.string().uuid() })

export const updateCardPlanItemSchema = z.object({
  runId: z.string().uuid(),
  itemId: z.string().uuid(),
  meaning: z.string().trim().min(1).max(2000),
  visualBrief: z.string().trim().min(1).max(4000),
})

export const confirmCardPlanSchema = z.object({ runId: z.string().uuid() })
