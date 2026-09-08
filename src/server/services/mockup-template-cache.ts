import type { MockupExternalTemplateView } from "@/lib/mockup/types"

/**
 * 模板列表进程内短缓存（原 actions/mockup.ts 内部实现抽出）。
 *
 * 抽出原因：PSD 上传改走 /api/mockup/psd-upload 路由（Server Action 大 body
 * 在 dev 下 multipart 流被截断报 "Unexpected end of form"），路由侧上传成功
 * 后需要失效同一份缓存，必须与 listExternalTemplatesAction 共享模块实例。
 */

export interface MockupTemplateListResult {
  ok: boolean
  error: string | null
  templates: MockupExternalTemplateView[]
}

export const TEMPLATE_LIST_TTL_MS = 60_000

export const templateListCache = new Map<string, { expiresAt: number; value: MockupTemplateListResult }>()
export const templateListInflight = new Map<string, Promise<MockupTemplateListResult>>()
export const templateListGeneration = new Map<string, number>()

export function invalidateTemplateListCache(enterpriseId: string): void {
  templateListGeneration.set(
    enterpriseId,
    (templateListGeneration.get(enterpriseId) ?? 0) + 1,
  )
  const prefix = `${enterpriseId}:`
  for (const key of [...templateListCache.keys()]) {
    if (key.startsWith(prefix)) templateListCache.delete(key)
  }
}
