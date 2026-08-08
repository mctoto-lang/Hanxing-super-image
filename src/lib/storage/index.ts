import { saveFromUrl, saveFromBuffer } from "@/lib/storage/local"
import { env } from "@/lib/env"

/**
 * 存储统一接口（手册 §3、§10.5）
 *
 * 按 system_settings 切换 COS / 本地（v1 默认本地，COS M7 接入）。
 */

export interface StorageAdapter {
  /** 从远程 URL 拉取并转存，返回可访问 URL */
  saveFromUrl(
    sourceUrl: string,
    enterpriseId: string,
    kind?: "image" | "thumb",
  ): Promise<string>
  /** 从 Buffer 保存 */
  saveFromBuffer(
    buffer: Buffer,
    enterpriseId: string,
    ext: string,
    kind?: "image" | "thumb",
  ): Promise<string>
}

const localAdapter: StorageAdapter = {
  saveFromUrl,
  saveFromBuffer,
}

/** 是否配置了 COS（M7 完整接入） */
function isCosConfigured(): boolean {
  return Boolean(env.COS_SECRET_ID && env.COS_SECRET_KEY && env.COS_BUCKET)
}

/** 获取当前存储适配器（默认本地；COS 配置完整时启用 COS，M7 接入） */
export function getStorage(): StorageAdapter {
  // M7 阶段接入 cosAdapter
  if (isCosConfigured()) {
    // TODO(M7): return cosAdapter
  }
  return localAdapter
}

export { saveFromUrl, saveFromBuffer }
