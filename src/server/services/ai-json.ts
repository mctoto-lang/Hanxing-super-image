import { getStorage } from "@/lib/storage"
import { resolveProductChatConfig } from "@/server/services/product-ai-config"
import {
  callChatApi,
  parseAiJson,
  type ChatContentPart,
} from "@/server/services/workspace-ai"
import type { AiDegradeReason } from "@/lib/product/types"

/**
 * AI 交互同步调用（商品图片/穿戴图片共用）
 *
 * vision 优先、失败自动降级纯文本重试一次；结构化 JSON 输出。
 * 原实现内联在 product-v2.ts，穿戴图片接入时抽出为共享服务。
 */

/** AI 交互同步调用超时（帮写/智能匹配/单卡重试是交互式按钮，不用配置的 120s） */
export const AI_SYNC_TIMEOUT_MS = 30_000

/** 生成临时签名图片 URL（本地存储/失败返回 null，调用方降级纯文本） */
export async function presignImages(urls: string[]): Promise<(string | null)[]> {
  const storage = await getStorage()
  if (!storage.presignGet) return urls.map(() => null)
  return Promise.all(urls.map((u) => storage.presignGet!(u, 600)))
}

/**
 * 调对话模型（vision 优先，失败自动降级纯文本重试一次）。
 * 返回 parsed JSON；两次均失败抛错（调用方转 L2 兜底）。
 */
export async function callAiJson<T>(opts: {
  enterpriseId: string
  system: string
  userText: string
  images: string[]
  /** 同步等待上限（默认 30s；批量出卡等长输出场景放宽） */
  timeoutMs?: number
}): Promise<{ data: T; degraded: AiDegradeReason }> {
  const config = await resolveProductChatConfig(opts.enterpriseId)
  if (!config) throw new Error("未配置可用的对话模型，请联系管理员")

  const presigned = await presignImages(opts.images)
  const usable = presigned.filter((u): u is string => Boolean(u))

  const buildMessages = (withImages: boolean) => {
    const parts: ChatContentPart[] = []
    if (withImages && usable.length > 0) {
      parts.push(
        ...usable.map(
          (u): ChatContentPart => ({ type: "image_url", image_url: { url: u } }),
        ),
      )
    }
    parts.push({ type: "text", text: opts.userText })
    return [
      { role: "system" as const, content: opts.system },
      { role: "user" as const, content: parts },
    ]
  }

  const attempt = async (withImages: boolean, responseFormat: boolean) =>
    callChatApi({
      config,
      messages: buildMessages(withImages),
      timeoutMs: opts.timeoutMs ?? AI_SYNC_TIMEOUT_MS,
      temperature: 0.4,
      ...(responseFormat ? { responseFormat: "json_object" as const } : {}),
    })

  let degraded: AiDegradeReason = null
  let raw: string
  try {
    if (usable.length === 0) throw new Error("no-vision")
    // 先带 response_format；网关不支持时降级重试（prompt 已约束只输出 JSON）
    try {
      raw = await attempt(true, true)
    } catch {
      raw = await attempt(true, false)
    }
  } catch {
    degraded = usable.length === 0 ? "no-vision" : "ai-failed"
    try {
      raw = await attempt(false, true)
    } catch {
      raw = await attempt(false, false)
    }
  }

  try {
    return { data: parseAiJson<T>(raw), degraded }
  } catch {
    // JSON 解析失败：按纯文本再试一次（部分模型在长输出时混入杂文）
    if (degraded === null) degraded = "ai-failed"
    const retry = await attempt(false, false)
    return { data: parseAiJson<T>(retry), degraded }
  }
}
