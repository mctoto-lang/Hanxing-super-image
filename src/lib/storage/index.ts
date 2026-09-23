import { saveFromUrl, saveFromBuffer, deleteObjects } from "@/lib/storage/local"
import {
  loadStorageConfig,
  type StorageConfig,
  type ImageCategory,
} from "@/lib/storage/config"
import { createCosAdapter } from "@/lib/storage/cos"

/**
 * 存储统一接口（手册 §3、§10.5）
 *
 * 按 system_setting 的 provider 切换 COS / 本地。COS 模式按 category 路由到
 * 上传桶 / 生成桶与对应前缀（见 config.ts）。provider=local 或 COS 未配齐时回退本地。
 */

export interface StorageAdapter {
  /** 从远程 URL 拉取并转存（用于 AI 上游结果图），返回可访问 URL。
   *  trustedHostHints：调用方可信域名提示（如模型 API 端点），同站域名自动放行。 */
  saveFromUrl(
    sourceUrl: string,
    enterpriseId: string,
    category: ImageCategory,
    trustedHostHints?: string[],
  ): Promise<string>
  /** 从 Buffer 保存，返回可访问 URL */
  saveFromBuffer(
    buffer: Buffer,
    enterpriseId: string,
    ext: string,
    category: ImageCategory,
  ): Promise<string>
  /**
   * 删除对象（按可访问 URL）；已不存在视为成功。
   * cleanup cron 按保留天数清理过期图；保留 DB 中的 URL，前端用占位提示。
   */
  deleteObjects(urls: string[]): Promise<number>
  /**
   * 生成临时签名 GET URL（供外部 AI 服务读取私有桶图片）。
   * 本地存储不可达公网，适配器可不实现（调用方据此降级纯文本）。
   */
  presignGet?(url: string, expiresSec?: number): Promise<string | null>
}

/** category → 本地 kind 子目录（local 仅用 image/thumb 区分，忽略桶/前缀语义） */
function categoryToKind(category: ImageCategory): "image" | "thumb" {
  return category === "thumb" ? "thumb" : "image"
}

const localAdapter: StorageAdapter = {
  saveFromUrl: (sourceUrl, enterpriseId, category, trustedHostHints) =>
    saveFromUrl(
      sourceUrl,
      enterpriseId,
      categoryToKind(category),
      trustedHostHints,
    ),
  saveFromBuffer: (buffer, enterpriseId, ext, category) =>
    saveFromBuffer(buffer, enterpriseId, ext, categoryToKind(category)),
  deleteObjects,
}

/** COS 是否配齐（凭证 + 桶名） */
function isCosConfigured(cfg: StorageConfig): boolean {
  return Boolean(
    cfg.cosSecretId && cfg.cosSecretKey && cfg.cosRegion && cfg.cosBucket,
  )
}

/**
 * 获取当前存储适配器（异步读 system_setting）。
 *
 * provider=cos 且凭证/双桶配齐 → COS 适配器；否则回退本地。
 * 适配器带 60s TTL 缓存 + COS SDK 实例复用：getStorage 是 worker 热路径
 * （每个生图任务、每张图转存都调用），每次重建 SDK 实例开销大。
 * 配置改动由 saveStorageSettingAction 显式失效（resetStorageAdapterCache），
 * 其余场景最迟 60s 生效（与图片代理的存储配置缓存同策略）。
 */
let adapterCache: { at: number; adapter: StorageAdapter } | null = null
const ADAPTER_CACHE_TTL_MS = 60_000

export async function getStorage(): Promise<StorageAdapter> {
  if (adapterCache && Date.now() - adapterCache.at < ADAPTER_CACHE_TTL_MS) {
    return adapterCache.adapter
  }
  const cfg = await loadStorageConfig()
  const adapter =
    cfg.provider === "cos" && isCosConfigured(cfg)
      ? createCosAdapter(cfg)
      : localAdapter
  adapterCache = { at: Date.now(), adapter }
  return adapter
}

/** 失效适配器缓存（存储配置保存后调用，改动即时生效） */
export function resetStorageAdapterCache(): void {
  adapterCache = null
}

export type { ImageCategory, StorageConfig } from "@/lib/storage/config"
export { createCosAdapter } from "@/lib/storage/cos"
export { saveFromUrl, saveFromBuffer } from "@/lib/storage/local"
