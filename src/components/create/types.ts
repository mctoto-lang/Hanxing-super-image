import type { ModelExtraConfig, ModelSizePreset } from "@/db/schema"

/**
 * 创作页可用模型类型（自由创作页 §6）
 *
 * 从原 create-workspace.tsx 提取，供 create-dialog / model-picker /
 * conversation-detail / page 等组件共享。
 */
export interface CreateModel {
  id: string
  name: string
  displayName: string
  /** 模型描述（卡片名称下方） */
  description: string | null
  /** 名称后勋章文字 */
  badgeText: string | null
  /** 勋章配色 key（见 src/lib/model-badges.ts） */
  badgeColor: string | null
  costPerImage: number
  /** 结构化尺寸预设；空表示使用系统默认 */
  sizePresets: ModelSizePreset[] | null
  /** 创作页是否显示 1-4 生成数量选择（即梦模型下为「次数」，每次出 jimengN 张） */
  supportsImageCount: boolean
  /** 是否支持「智能」比例（size=auto，模型决定尺寸） */
  supportsSmartSize: boolean
  supportsReferenceImage: boolean
  maxReferenceImages: number
  apiFormat: "openai" | "jimeng"
  extraConfig: ModelExtraConfig | null
  iconUrl: string | null
  /** listAvailableModelsAction 多查的字段，权限校验用 */
  enterpriseId?: string | null
}
