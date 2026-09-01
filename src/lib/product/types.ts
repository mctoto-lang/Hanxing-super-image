/**
 * 商品主图 V2 类型定义（四 tab：商品套图 / A+详情页 / 爆款复刻 / 产品精修）
 */

import type { ModelSizePreset } from "@/db/schema"

/** 方向行（前端展示，含超管可配字段） */
export interface ProductDirectionRow {
  id: string
  key: string
  name: string
  description: string | null
  promptTemplate: string
  supportsCount: boolean
  maxCount: number
  sortOrder: number
  /** 前端隐藏：不出现在套图自定义配置手动列表（AI 候选池不受影响） */
  isHidden: boolean
  /** 白底图类（主图）：生图时注入平台主图规范 */
  isHero: boolean
}

/** 尺寸规范行（前端展示） */
export interface PlatformSizeSpecRow {
  id: string
  platformKey: string
  label: string
  width: number
  height: number
  ratioLabel: string | null
  note: string | null
}

/** 可选模型（前端展示；apiFormat 用于即梦英文文字警示） */
export interface ProductModelRow {
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

/** 上架平台下拉项（DB 化配置） */
export interface ProductPlatformOption {
  key: string
  label: string
}

/** 语言下拉项（DB 化配置） */
export interface ProductLanguageOption {
  key: string
  label: string
}

/** 单个生成任务（批次内，前端展示） */
export interface ProductBatchTaskRow {
  id: string
  status: "queued" | "processing" | "completed" | "failed"
  directionKey: string | null
  directionName: string | null
  replicateLevel: string | null
  imageUrl: string | null
  errorMessage: string | null
  /** 失败已退积分（按张退款） */
  refunded: number
  createdAt: Date
  /** 生图模型展示名（查看器元信息） */
  model: string | null
  /** 生图提示词全文（查看器元信息） */
  prompt: string | null
}

/** 批次（batchTag 聚合，前端展示） */
export interface ProductBatchRow {
  batchTag: string
  mode: string
  platform: string | null
  language: string | null
  total: number
  completed: number
  failed: number
  /** 批次状态：任一未终态 → 进行中 */
  status: "processing" | "completed" | "partial_failed"
  createdAt: Date
  tasks: ProductBatchTaskRow[]
}

/** AI 帮写产物：编号格式的商品信息文本块（填入合并输入框） */
export interface AiBriefResult {
  brief: string
}

/** 智能匹配单方向定制变量 */
export interface SmartMatchSlot {
  key: string
  selected: boolean
  angle?: string
  focus?: string
  copyHint?: string
  target?: string
  count?: number
}

/** 智能匹配产物 */
export interface SmartMatchResult {
  productAnalysis: {
    category?: string
    materials?: string[]
    colors?: string[]
    designFeatures?: string[]
  }
  slots: SmartMatchSlot[]
}

/** AI Action 降级标记（null=正常 vision 调用成功） */
export type AiDegradeReason = "no-vision" | "ai-failed" | null

/** 套图卡片（卡片确认阶段；prompt 可被用户编辑，提交时服务端再拼装平台/语言段） */
export interface SuiteCard {
  directionKey: string
  directionName: string
  /** AI 生成的画面提示词（可编辑） */
  prompt: string
  /** 智能匹配定制（展示与单卡重生成用） */
  vars?: {
    angle?: string
    focus?: string
    copyHint?: string
    target?: string
  }
  /** 白底图类（主图）：前端预览需拼接平台主图规范段 */
  isHero?: boolean
}
