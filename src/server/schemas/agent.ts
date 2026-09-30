import { z } from "zod"

/**
 * AI Agent 域 zod schemas（固定流水线：三产品线发起/预估/控制）
 *
 * - 发起入参：方向 + 创作提示词 + 可选张数（神谕）+ 风格参考图（≤4）；
 * - 图结构为代码内置（buildPipelineGraph），不再有用户可编辑工作流。
 */

export const agentNodeTypeSchema = z.enum([
  "start",
  "agent",
  "image_gen",
  "review",
  "supervisor",
  "human",
  "end",
])

export const directionSchema = z.enum(["tarot", "oracle", "poker"])

/** 发起/预估共用入参 */
export const deckRunInputSchema = z.object({
  direction: directionSchema,
  /** 创作提示词（主题 + 风格描述） */
  prompt: z.string().min(5, "提示词太短，请描述主题与期望风格").max(2000),
  /** 张数（神谕卡必填且限档位；塔罗/扑克固定，可缺省） */
  cardCount: z.number().int().min(1).max(78).optional(),
  /** 风格参考图 URL（≤4） */
  referenceImages: z.array(z.string().url()).max(4).default([]),
})

export const runControlSchema = z.object({
  runId: z.string().uuid(),
})

export const confirmItemSchema = z.object({
  itemId: z.string().uuid(),
  roundId: z.string().uuid(),
})

export const regenItemSchema = z.object({
  itemId: z.string().uuid(),
})

export const agentTasksQuerySchema = z.object({
  runId: z.string().uuid(),
  nodeKey: z.string().min(1).max(60),
})

/** 资产尺寸值（WxH；空串 = 跟随平台经典 imageSize，由消费侧 || 链回退） */
const assetSizeValue = z.string().regex(/^(\d+x\d+)?$/, "尺寸格式应为 WxH（如 1024x1024），或留空跟随平台")

// ── 平台配置 ──

export const directionConfigUpdateSchema = z.object({
  direction: directionSchema,
  enabled: z.boolean().optional(),
  sampleEnabled: z.boolean().optional(),
  sampleCount: z.number().int().min(1).max(12).optional(),
  // 打回上限全站统一 0-3（用户发起弹窗/用户侧校验同限；超限配置会让所有
  // 用户创建项目时被用户侧 zod 拒绝）
  maxRetries: z.number().int().min(0).max(3).optional(),
  thresholds: z
    .object({
      aestheticThreshold: z.number().int().min(40).max(95),
      consistencyThreshold: z.number().int().min(40).max(95),
    })
    .optional(),
  models: z
    .object({
      styleChatModelId: z.string().uuid().nullable(),
      structureChatModelId: z.string().uuid().nullable(),
      copywriterChatModelId: z.string().uuid().nullable(),
      copywriterThinkingLevel: z.enum(["off", "low", "medium", "high", "extra", "max", "ultracode"]).optional(),
      imageModelId: z.string().uuid().nullable(),
      imageSize: z.string().max(20),
      contentReviewModelId: z.string().uuid().nullable(),
      aestheticReviewModelId: z.string().uuid().nullable(),
      consistencyReviewModelId: z.string().uuid().nullable(),
    })
    .optional(),
  templateConfig: z.object({
    template: z.literal("tarot"),
    copywriterChatModelId: z.string().uuid().nullable().optional(),
    reviewerModelIds: z.array(z.string().uuid()).min(1).max(3),
    // 资产尺寸键集固定为 7 个模板资产键（与 TEMPLATE_ASSET_SIZE_KEYS 对齐，
    // strict 拒绝多余键）；之前 z.record 放行任意键，多余/缺失键被类型断言
    // 掩盖后静默落库。空串 = 跟随平台经典尺寸。
    assetSizes: z
      .object({
        card: assetSizeValue,
        border: assetSizeValue,
        back: assetSizeValue,
        box_front: assetSizeValue,
        box_back: assetSizeValue,
        box_side: assetSizeValue,
        box_top: assetSizeValue,
      })
      .strict(),
    reviewThresholds: z.object({ content: z.number().int().min(40).max(95), aesthetic: z.number().int().min(40).max(95), consistency: z.number().int().min(40).max(95) }),
    maxRetries: z.number().int().min(0).max(3),
    sampleCount: z.number().int().min(1).max(12),
    concurrency: z.number().int().min(1).max(4),
    clarifyMaxRounds: z.number().int().min(1).max(8),
    frameMode: z.literal("ai"),
    aiFrameModelId: z.string().uuid().nullable(),
    assetImageModelId: z.string().uuid().nullable(),
    cardImageModelId: z.string().uuid().nullable(),
  }).optional(),
})
