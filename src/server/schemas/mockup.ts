import { z } from "zod"

/**
 * 样机渲染 zod schemas
 *
 * 小模板（外部 PSD 模板）的绑定定义与外部 /v1 结构对齐；大模板/卡片/图片库
 * 为网页侧自有数据。URL 类字段在 Action 内再经 validateReferenceImageUrls
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

/** 大模板成员入参（绑定/画布/版本由 Action 从外部模板详情快照，客户端只选模板） */
export const mockupGroupItemInputSchema = z.object({
  /** 外部模板 ID（tpl_） */
  templateId: z.string().min(1).max(64),
  displayName: z.string().min(1).max(120).optional(),
  sortOrder: z.number().int().min(0).max(999).default(0),
})

export const createMockupGroupSchema = z.object({
  name: z.string().min(1, "请输入大模板名称").max(100),
  items: z
    .array(mockupGroupItemInputSchema)
    .min(1, "请至少选择 1 个小模板")
    .max(50),
})
export type CreateMockupGroupInput = z.infer<typeof createMockupGroupSchema>

export const updateMockupGroupSchema = createMockupGroupSchema.extend({
  id: z.string().uuid(),
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

/** 渲染：传一个或多个卡片（顶部批量渲染 = 全部卡片 ID） */
export const renderMockupCardsSchema = z.object({
  cardIds: z.array(z.string().uuid()).min(1).max(50),
})
export type RenderMockupCardsInput = z.infer<typeof renderMockupCardsSchema>

/** 保存小模板绑定并（可选）发布 */
export const saveTemplateBindingsSchema = z.object({
  templateId: z.string().min(1).max(64),
  bindings: z.array(mockupBindingDefSchema).min(1).max(50),
  publish: z.boolean().default(true),
})
