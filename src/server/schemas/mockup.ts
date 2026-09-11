import { z } from "zod"

/**
 * 样机渲染 zod schemas
 *
 * 小模板（外部 PSD 模板）的绑定定义与外部 /v1 结构对齐；大模板/卡片/图片库/
 * 批量替换为网页侧自有数据。URL 类字段在 Action 内再经 validateReferenceImageUrls
 * 做归属校验（防跨租户引用）。
 */

/** 小模板绑定定义（与外部 PUT /v1/templates/:id/layer-bindings 对齐） */
export const mockupBindingDefSchema = z.object({
  bindingId: z.string().min(1).max(64),
  layerId: z.number().int(),
  layerPath: z.string().min(1).max(500),
  type: z.enum(["smartObject", "text", "pixel"]),
  required: z.boolean().default(true),
  label: z.string().max(100).optional(),
  acceptedFormats: z.array(z.string().max(20)).max(10).optional(),
  fit: z.enum(["cover", "contain", "stretch"]).default("stretch"),
  maxLength: z.number().int().positive().max(10000).optional(),
  defaultFontVersionId: z.string().max(64).optional(),
})
export type MockupBindingDefInput = z.infer<typeof mockupBindingDefSchema>

export const mockupVisibilitySchema = z.enum(["public", "private"])

/** 大模板成员入参（绑定/画布/版本由 Action 从外部模板详情快照，客户端只选模板） */
export const mockupGroupItemInputSchema = z.object({
  /** 外部模板 ID（tpl_） */
  templateId: z.string().min(1).max(64),
  displayName: z.string().min(1).max(120).optional(),
  sortOrder: z.number().int().min(0).max(999).default(0),
})

export const createMockupGroupSchema = z.object({
  name: z.string().min(1, "请输入大模板名称").max(100),
  visibility: mockupVisibilitySchema.default("private"),
  items: z
    .array(mockupGroupItemInputSchema)
    .min(1, "请至少选择 1 个小模板")
    .max(50),
})
export type CreateMockupGroupInput = z.infer<typeof createMockupGroupSchema>

export const updateMockupGroupSchema = createMockupGroupSchema.extend({
  id: z.string().uuid(),
})

export const setMockupGroupVisibilitySchema = z.object({
  groupId: z.string().uuid(),
  visibility: mockupVisibilitySchema,
})

/** 从小模板直接建卡（自动创建/复用单成员套组） */
export const createCardFromTemplateSchema = z.object({
  templateId: z.string().min(1).max(64),
  title: z.string().max(120).optional(),
})

/** 卡片绑定配置：单绑定 = 图片 URL 或文字 */
export const mockupBindingSettingSchema = z.object({
  imageUrl: z.string().max(2048).optional(),
  text: z.string().max(2000).optional(),
})

export const saveCardBindingsSchema = z.object({
  cardId: z.string().uuid(),
  groupItemId: z.string().uuid(),
  bindings: z.record(
    z.string().min(1).max(64),
    mockupBindingSettingSchema,
  ),
})
export type SaveCardBindingsInput = z.infer<typeof saveCardBindingsSchema>

export const createMockupCardSchema = z.object({
  groupId: z.string().uuid(),
})

export const renameMockupCardSchema = z.object({
  cardId: z.string().uuid(),
  title: z.string().min(1, "请输入卡片名称").max(120),
})

/** 图片库收录（上传到本项目存储成功后登记） */
export const addMockupDesignAssetSchema = z.object({
  imageUrl: z.string().min(1).max(2048),
  fileName: z.string().max(255).optional(),
})

/** 素材预导入（图片库上传/批量选图时预热外部 assetId 缓存） */
export const prewarmMockupAssetsSchema = z.object({
  imageUrls: z.array(z.string().min(1).max(2048)).min(1).max(100),
})

/** 渲染：传一个或多个卡片（顶部批量渲染 = 全部卡片 ID） */
export const renderMockupCardsSchema = z.object({
  cardIds: z.array(z.string().uuid()).min(1).max(50),
  /** 导出格式（PS-API output.format；jpeg=JPG 图片、psd=保留图层的 PSD 源文件；默认 JPG） */
  outputFormat: z.enum(["png", "jpeg", "psd"]).default("jpeg"),
})
export type RenderMockupCardsInput = z.infer<typeof renderMockupCardsSchema>

/** 保存小模板绑定并（可选）发布；背景标记存本地扩展表 */
export const saveTemplateBindingsSchema = z.object({
  templateId: z.string().min(1).max(64),
  bindings: z.array(mockupBindingDefSchema).min(1).max(50),
  publish: z.boolean().default(true),
  /** 标记为背景的 bindingId 列表（须包含在 bindings 内） */
  backgroundBindingIds: z.array(z.string().min(1).max(64)).max(50).default([]),
})

/* ─── 批量替换 ─── */

/** 单批次上限：防外部渲染服务排队压力（分块提交，每块 ≤50 见 service 层） */
export const MOCKUP_BATCH_MAX_TASKS = 100

/** 批量替换提交：固定绑定 + 逐任务轮换的图片/文字（数组等长） */
export const submitMockupBatchSchema = z
  .object({
    templateId: z.string().min(1).max(64),
    /** 固定绑定值（背景图/固定文字，每个任务相同） */
    fixed: z.record(z.string().min(1).max(64), mockupBindingSettingSchema),
    /** 轮换图片：bindingId → 已上传到本项目存储的 URL 列表 */
    batchImages: z.record(
      z.string().min(1).max(64),
      z.array(z.string().min(1).max(2048)),
    ),
    /** 轮换文字：bindingId → 文本列表（可与图片数不等，不足留空） */
    batchTexts: z.record(
      z.string().min(1).max(64),
      z.array(z.string().max(2000)),
    ),
    /** 任务标签（来源文件名等，长度须等于任务数；可省略） */
    labels: z.array(z.string().max(255)).max(MOCKUP_BATCH_MAX_TASKS).optional(),
    /** 导出格式（PS-API output.format；jpeg=JPG 图片、psd=保留图层的 PSD 源文件；默认 JPG） */
    outputFormat: z.enum(["png", "jpeg", "psd"]).default("jpeg"),
  })
  .refine(
    (d) =>
      Object.values(d.batchImages).every((urls) => urls.length > 0) &&
      Object.values(d.batchTexts).every((texts) => texts.length > 0),
    { message: "轮换图片/文字列表不能为空" },
  )
  .refine((d) => Object.keys(d.batchImages).length + Object.keys(d.batchTexts).length > 0, {
    message: "请至少配置一个轮换的图片或文字绑定",
  })
export type SubmitMockupBatchInput = z.infer<typeof submitMockupBatchSchema>
export type SubmitMockupBatchParsed = z.output<typeof submitMockupBatchSchema>

/* ─── AI 生图（背景等固定图绑定 / 方块 AI背景 / AI渲染） ─── */

export const submitMockupBackgroundSchema = z.object({
  modelId: z.string().uuid(),
  prompt: z.string().min(1, "请输入提示词").max(4000),
  imageSize: z.string().min(1).max(30),
  referenceImages: z.array(z.string().max(2048)).max(8).optional(),
  /** 方块 AI 上下文（菜单 AI背景/AI渲染）：传入后参考图固定为该方块渲染原图 */
  cardId: z.string().uuid().optional(),
  groupItemId: z.string().uuid().optional(),
  aiKind: z.enum(["background", "render"]).optional(),
})

/** AI背景落地：生成完成 → 填入卡片背景绑定 + 自动重渲染 */
export const applyMockupAiBackgroundSchema = z.object({
  taskId: z.string().uuid(),
})
