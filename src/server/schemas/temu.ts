import { z } from "zod"

/**
 * Temu 采集 zod schemas
 *
 * - ingest 系列为 /api/v1/ingest 机器上报契约（宽松校验：字段缺失/null 均容忍，
 *   畸形条目由路由逐条 try/catch 隔离，不阻塞整批）；
 * - 面板查询/店铺管理系列为 Server Action 入参（企业隔离在 Action 内强制）。
 */

// ---------- 插件上报契约 ----------

export const ingestItemSchema = z.object({
  /** 插件规则 id（dashboard-stats / products-list / activity-data…） */
  source: z.string().min(1).max(64),
  kind: z.string().max(16).optional(),
  /** 插件侧店铺快照 id（服务端以 token 归属为准，仅审计比对） */
  storeId: z.string().max(64).nullable().optional(),
  /** 数据内嵌 mall 归属（supplierId → mallName） */
  mallMeta: z
    .object({
      supplierIds: z.array(z.string().max(32)).max(20).optional(),
      mallNames: z.array(z.string().max(100)).max(20).optional(),
    })
    .nullable()
    .optional(),
  page: z.string().max(2000).nullable().optional(),
  capturedAt: z.number().int().positive(),
  /** 规则引擎规范化结果（标量字段 + items 列表） */
  normalized: z.unknown().optional(),
  /** 原始响应（可选，插件 keepRaw 开关；超大已在上报端截断） */
  raw: z.unknown().optional(),
  dedupKey: z.string().max(200).optional(),
})
export type IngestItem = z.infer<typeof ingestItemSchema>

export const ingestBodySchema = z.object({
  deviceTime: z.number().int().optional(),
  storeId: z.string().max(64).nullable().optional(),
  items: z.array(ingestItemSchema).min(1).max(100),
})
export type IngestBody = z.infer<typeof ingestBodySchema>

// ---------- 面板查询（URL 驱动参数） ----------

export const temuTabSchema = z.enum(["overview", "products", "flow", "activity", "stores"])
export type TemuTab = z.infer<typeof temuTabSchema>

export const temuListQuerySchema = z.object({
  tab: temuTabSchema.default("overview"),
  /** 店铺筛选（空字符串 = 全部店铺） */
  store: z.string().uuid().optional(),
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
})
export type TemuListQuery = z.infer<typeof temuListQuerySchema>

// ---------- 店铺管理（企业管理员） ----------

export const createTemuStoreSchema = z.object({
  name: z.string().min(1, "请输入店铺名称").max(100),
  mallId: z.string().max(32).optional(),
  mallName: z.string().max(100).optional(),
})
export type CreateTemuStoreInput = z.infer<typeof createTemuStoreSchema>

export const resetTemuStoreTokenSchema = z.object({
  id: z.string().uuid(),
})

export const toggleTemuStoreSchema = z.object({
  id: z.string().uuid(),
  enabled: z.boolean(),
})

export const deleteTemuStoreSchema = z.object({ id: z.string().uuid() })
