/**
 * 工作台共享类型（客户端/服务端通用，1:1 对齐旧项目）
 *
 * 新项目用 UUID 字符串替代旧项目的数字 ID。
 */

import type { ModelSizePreset } from "@/db/schema"

/** 对话 API 配置（精简版，供前端展示） */
export interface ChatApiOption {
  id: string
  name: string
  displayName: string
  /** 平台预置（enterpriseId 为空）= true；企业私有 = false */
  isPlatformPreset: boolean
}

/** 提示词模板 */
export interface TemplateRow {
  id: string
  type: TemplateType
  name: string
  content: string
  chatApiId: string | null
  chatApiName: string | null
  fissionCount: number | null
  ownerId: string | null
  visibility: "private" | "public"
  status: "active" | "archived"
  createdAt: Date
}

export type TemplateType =
  | "fission"
  | "deepen"
  | "regenerate"
  | "extract"
  | "translate"

/** 图片模型（精简版，供前端展示）
 *
 * sizePresets 为结构化尺寸预设（[{label,width,height}]），与 create 页一致；
 * 空表示使用默认预设（见 src/lib/image-sizes.ts）。
 */
export interface ImageModelRow {
  id: string
  name: string
  displayName: string | null
  sizePresets: ModelSizePreset[] | null
  iconUrl: string | null
  supportsReferenceImage: boolean
  maxReferenceImages: number | null
  costPerImage: number
}

/** 工作台任务 */
export interface WorkspaceTaskRow {
  id: string
  title: string
  themePrompt: string
  templateId: string | null
  templateName: string | null
  status: "generating" | "completed" | "failed"
  cardCount: number
  thumbnailUrl: string | null
  thumbnailUrls: string[]
  completedImageCount: number
  generatingImageCount: number
  failedImageCount: number
  isPinned: boolean
  errorMessage: string | null
  createdAt: Date
  updatedAt: Date
}

/** 提示词卡片 */
export interface PromptCardRow {
  id: string
  taskId: string
  cardIndex: number
  prompt: string
  translatedPrompt: string | null
  translationSourcePrompt: string | null
  translationStatus: "none" | "translating" | "synced" | "outdated" | "failed"
  translationTemplateId: string | null
  displayLanguage: "zh" | "en"
  selectedImageId: string | null
  referenceImages: string[]
  // 选中图片的冗余字段（JOIN 查询填充）
  selImgId: string | null
  selImgUrl: string | null
  selImgModelName: string | null
  selImgSize: string | null
  selImgStartedAt: Date | null
  selImgCompletedAt: Date | null
  selImgCreatedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** 卡片图片 */
export interface CardImageRow {
  id: string
  cardId: string
  generationTaskId: string | null
  generationPrompt: string | null
  imageApiId: string | null
  imageUrl: string
  modelName: string | null
  size: string | null
  format: string
  status: "pending" | "generating" | "completed" | "failed"
  errorMessage: string | null
  isSelected: boolean
  source: "generated" | "uploaded"
  generationStartedAt: Date | null
  generationCompletedAt: Date | null
  createdAt: Date
}

/** 任务下所有卡片的图片聚合（轮询用） */
export interface TaskCardImagesPayload {
  /** 本次响应的服务器时间（ISO），客户端下次增量轮询作为 since 传回 */
  serverTime?: string
  /** true = cards[].images 只含变化行 + 选中行，客户端按 id upsert 合并 */
  incremental?: boolean
  cards: Record<
    string,
    {
      cardId: string
      pendingCount: number
      completedCount: number
      failedCount: number
      /** 增量模式下未取到时省略（undefined = 客户端保留上一轮值） */
      selectedImage?: {
        id: string
        imageUrl: string
        modelName: string | null
        size: string | null
        startedAt: Date | null
        completedAt: Date | null
        createdAt: Date
      } | null
      images: CardImageRow[]
    }
  >
}

/** 生成配置（localStorage 持久化） */
export interface StoredGenerationConfig {
  fissionTemplate: TemplateRow | null
  refineTemplate: TemplateRow | null
  regenTemplate: TemplateRow | null
  extractTemplate: TemplateRow | null
  translateTemplate: TemplateRow | null
  imageModel: ImageModelRow | null
  size: string | null
}

export type BatchGenerationLanguage = "zh" | "en"
