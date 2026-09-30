import { z } from "zod"

export const agentAssetKindSchema = z.enum(["border", "back", "box_front", "box_back", "box_side", "box_top"])
export const listAgentAssetsSchema = z.object({ runId: z.string().uuid() })
export const createAgentAssetSchema = z.object({
  runId: z.string().uuid(),
  kind: agentAssetKindSchema,
  url: z.string().url(),
  name: z.string().trim().max(200).optional(),
  source: z.enum(["upload", "ai"]).default("upload"),
  prompt: z.string().max(10000).optional(),
})
export const confirmAgentAssetSchema = z.object({ runId: z.string().uuid(), assetId: z.string().uuid() })
