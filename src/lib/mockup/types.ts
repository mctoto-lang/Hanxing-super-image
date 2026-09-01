/**
 * 样机渲染前端视图类型（page data / 轮询状态 / 弹窗数据）
 *
 * 由 server actions 组装下发，客户端组件只消费这些结构。
 */

import type { MockupBindingConfig } from "@/db/schema"

/** 绑定定义（加入套组时的快照，渲染前校验用） */
export interface MockupBindingDefView {
  bindingId: string
  type: "smartObject" | "text" | "pixel"
  layerId: number
  layerPath: string
  label: string
  required: boolean
  fit: "cover" | "contain" | "stretch"
}

export interface MockupGroupItemView {
  id: string
  displayName: string
  templateVersionId: string
  externalTemplateId: string
  canvasWidth: number | null
  canvasHeight: number | null
  bindings: MockupBindingDefView[]
  sortOrder: number
}

export interface MockupGroupView {
  id: string
  name: string
  items: MockupGroupItemView[]
}

/** 小方块任务视图（卡片上每个小模板的最新渲染） */
export interface MockupSquareTaskView {
  taskId: string
  status: "queued" | "processing" | "completed" | "failed"
  /** 0-100（外部进度透传） */
  progress: number
  /** DOWNLOAD / RUN_JSX / EXPORT / UPLOAD */
  stage: string | null
  errorMessage: string | null
  resultImage: string | null
  batchTag: string
  createdAt: string
}

export interface MockupCardItemView extends MockupGroupItemView {
  /** 该小模板最新批次的渲染任务（未渲染过为 null） */
  task: MockupSquareTaskView | null
  /** 必填绑定是否已配齐（渲染按钮可用性） */
  configured: boolean
}

export interface MockupCardView {
  id: string
  title: string
  groupId: string
  groupName: string
  createdAt: string
  updatedAt: string
  /** 卡片绑定配置（图层替换弹窗初始值） */
  bindingConfig: MockupBindingConfig
  items: MockupCardItemView[]
}

/** 图片库项 */
export interface MockupLibraryImage {
  id: string
  imageUrl: string
  fileName: string | null
  /** 生成图 tab：来源任务（收藏/定位用） */
  taskId?: string
}

/** 页面初始数据 */
export interface MockupPageData {
  /** false = 企业未配置/未开通样机渲染（显示引导空态） */
  available: boolean
  costPerRender: number
  groups: MockupGroupView[]
  cards: MockupCardView[]
  designAssets: MockupLibraryImage[]
  creditsBalance: number
}

/** 模板管理-外部小模板列表项 */
export interface MockupExternalTemplateView {
  templateId: string
  name: string
  code: string
  status: string
  statusLabel: string
  published: boolean
  latestVersion: number
  /** 服务端是否有缩略图（false 时显示占位 + 生成按钮） */
  hasThumbnail: boolean
  visibility: "public" | "private"
  createdAt: string
}

/** 渲染结果 */
export interface RenderMockupResult {
  ok: boolean
  error: string | null
  batchTag: string | null
  submitted: number
  failedSubmits: Array<{ displayName: string; message: string }>
  skipped: Array<{ cardId: string; displayName: string; reason: string }>
  cost: number
}

/** 轮询返回（进行中任务的实时状态） */
export interface MockupStatusUpdate {
  taskId: string
  cardId: string
  groupItemId: string
  batchTag: string
  status: "queued" | "processing" | "completed" | "failed"
  progress: number
  stage: string | null
  errorMessage: string | null
  resultImage: string | null
}

/** 卡片历史批次 */
export interface MockupHistoryBatch {
  batchTag: string
  createdAt: string
  tasks: Array<{
    taskId: string
    groupItemId: string
    displayName: string
    status: "queued" | "processing" | "completed" | "failed"
    resultImage: string | null
    errorMessage: string | null
    createdAt: string
  }>
}
