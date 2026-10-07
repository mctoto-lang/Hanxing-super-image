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
    // 评审团可为空：运行时回退经典三审槽位（buildTemplateProductionGraph 同口径）；
    // 仅限数量上限，避免清空/停用全部评审模型后保存任何字段都被拒
    reviewerModelIds: z.array(z.string().uuid()).max(3),
    // 资产尺寸仅卡面一键（与 TEMPLATE_ASSET_SIZE_KEYS 对齐，strict 拒绝
    // 多余键）——套件资产与 AI 融合一律延用卡面比例，不再逐资产配置；
    // 旧行的 border/back/box_* 键由 normalizeTarotTemplateConfig 在读取侧剔除。
    // 空串 = 跟随平台经典尺寸。
    assetSizes: z
      .object({
        card: assetSizeValue,
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
    // 角色提示词覆盖（空 = 内置默认；键集与 pipelines.TEMPLATE_ROLE_PROMPT_KEYS 对齐）
    rolePrompts: z
      .object({
        prompt_designer: z.string().max(4000, "初稿设计师角色提示词过长（上限 4000 字）").optional(),
        final_refiner: z.string().max(4000, "终稿细化师角色提示词过长（上限 4000 字）").optional(),
        reviewer: z.string().max(4000, "评审团角色提示词过长（上限 4000 字）").optional(),
      })
      .optional(),
    artRules: z.string().max(2000, "画面规则过长（上限 2000 字）").optional(),
  }).optional(),
})
