/**
 * 穿戴图片类型定义（四 tab：服装组图 / 模特穿戴 / AI万戴 / AI换色）
 */

import type { ModelSizePreset } from "@/db/schema"

/** 预置场景行（前端展示；promptTemplate 由服务端注入使用，不下发） */
export interface WeartrySceneRow {
  id: string
  key: string
  name: string
  description: string | null
}

/** 可选模型（前端展示；apiFormat 用于即梦英文文字警示） */
export interface WeartryModelRow {
  id: string
  name: string
  displayName: string
  sizePresets: ModelSizePreset[] | null
  iconUrl: string | null
  supportsReferenceImage: boolean
  maxReferenceImages: number
  costPerImage: number
  apiFormat: "openai" | "jimeng"
}

/** 单个生成任务（批次内，前端展示；复用商品页 BatchView，保留其兼容字段） */
export interface WeartryBatchTaskRow {
  id: string
  status: "queued" | "processing" | "completed" | "failed"
  directionKey: string | null
  directionName: string | null
  /** 恒 null（穿戴无复刻概念；结构兼容 BatchView） */
  replicateLevel: string | null
  sceneName: string | null
  imageUrl: string | null
  errorMessage: string | null
  /** 失败已退积分（按张退款） */
  refunded: number
  createdAt: Date
  /** 生图模型展示名（查看器元信息） */
  model: string | null
  /** 生图提示词全文（查看器元信息） */
  prompt: string | null
  /** 生成耗时（毫秒，查看器元信息）；未完成为 null */
  durationMs: number | null
}

/** 批次（batchTag 聚合，前端展示） */
export interface WeartryBatchRow {
  batchTag: string
  mode: string
  total: number
  completed: number
  failed: number
  /** 批次状态：任一未终态 → 进行中 */
  status: "processing" | "completed" | "partial_failed"
  createdAt: Date
  tasks: WeartryBatchTaskRow[]
}

/** AI 帮写产物：编号格式的商品信息文本块（与商品页契约一致） */
export interface WeartryAiBriefResult {
  brief: string
}

/** 模特形象库行（用户个人维度） */
export interface WeartryFigureRow {
  id: string
  imageUrl: string
  /** 来源：ai=生成自动入库 / upload=用户上传 */
  source: "ai" | "upload"
  createdAt: Date
}
