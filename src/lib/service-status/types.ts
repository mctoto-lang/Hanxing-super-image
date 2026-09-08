/**
 * 服务可用性共享类型（纯类型，客户端/服务端共用）
 *
 * 服务端：src/server/services/status-service.ts 组装；
 * API：GET /api/service-status；消费方：sidebar/service-status.tsx（弹窗）。
 */

export type ServiceHealth = "operational" | "degraded" | "down"

/**
 * 服务标识：chat = AI Chat API；ai = AI Image API；ps-api = Photoshop API；
 * storage = 分布式存储（COS）；postgres = 系统级服务（采样键沿用 postgres）
 */
export type ServiceKey = "chat" | "ai" | "ps-api" | "storage" | "postgres"

export interface HistoryPoint {
  /** 采样槽（UTC ISO 时间戳，对齐整 5 分钟） */
  slot: string
  status: ServiceHealth
}

export interface ServiceStatusItemView {
  key: ServiceKey
  status: ServiceHealth
  /** 是否已配置（未配置时展示「未配置」，不参与综合状态与历史） */
  configured: boolean
  latencyMs: number | null
  /** 附加信息（如「2端点」） */
  extra: string | null
  /** 该服务本次探测完成时间（ISO） */
  checkedAt: string
  /** 最近 30 个 5 分钟采样槽（约 2.5 小时），oldest → now，无样本的槽为 null */
  history: Array<HistoryPoint | null>
}

export interface ServiceStatusView {
  /** 各服务实时状态 + 历史 */
  services: ServiceStatusItemView[]
  /** 综合状态：任一 down → down；任一 degraded → degraded；否则 operational */
  overall: ServiceHealth
  /** 采样槽内正常运行占比（operational / 有样本槽，百分比保留 2 位）；无样本为 null */
  uptimePercent: number | null
  checkedAt: string
}
