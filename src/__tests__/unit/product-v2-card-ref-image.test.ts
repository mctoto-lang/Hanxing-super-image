import { describe, it, expect, beforeEach, vi } from "vitest"

/**
 * 出卡（批量/单卡重试）参考图归属校验回归单测。
 *
 * aiAssist/smartMatch 已在本批补 validateReferenceImageUrls，但同文件
 * runCardPromptGeneration 曾漏校验：企业 A 可传他企业 uploads/<entB>/ URL，
 * 借 callAiJson→presignGet 让上游 AI 描述他企业图片内容（跨租户读图）。
 * 本测验证两个出卡入口均拒绝跨租户参考图、且不触达 callAiJson；
 * 并以本企业 URL + 触发限流的正向对照证明合法图片不被误杀。
 *
 * session / 权限 / 限流 / AI 调用 / db / redis 均 mock，不触真实外部服务；
 * validateReferenceImageUrls 走真实实现（env / storage config mock）。
 */

const ENT_A = "11111111-1111-1111-1111-111111111111"
const ENT_B = "22222222-2222-2222-2222-222222222222"

const mockConsume = vi.hoisted(() => vi.fn(async () => true)) // 默认触发限流（正向对照用）
const mockCallAiJson = vi.hoisted(() => vi.fn(async () => ({ data: {}, degraded: "none" })))

vi.mock("@/lib/env", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.example.com" },
}))
vi.mock("@/lib/storage/config", () => ({
  loadStorageConfig: async () => ({}),
}))
vi.mock("@/lib/redis", () => ({ redis: {} })) // 不连真实 redis（限流已 mock）
vi.mock("@/db/client", () => ({ db: {} })) // 拒绝/限流路径均不触库
vi.mock("@/lib/auth/session", () => ({
  requireUserContext: async () => ({
    user: { id: "user-a", enterpriseId: ENT_A },
    enterprise: { id: ENT_A },
  }),
  getCurrentEnterpriseScope: () => ({ enterpriseId: ENT_A }),
}))
vi.mock("@/lib/auth/permissions", () => ({
  checkModuleAccess: () => null,
  checkModelAccess: () => null,
}))
vi.mock("@/lib/rate-limit", () => ({
  aiActionRateLimiter: { consume: mockConsume },
}))
vi.mock("@/server/services/product-config", () => ({
  resolveLanguage: async () => ({ outputName: "中文" }),
  resolvePlatform: async () => ({ key: "temu", label: "Temu" }),
  resolvePromptTemplate: async () => "system-prompt",
  listActiveLanguages: async () => [],
  listActivePlatforms: async () => [],
}))
vi.mock("@/server/services/ai-json", () => ({
  callAiJson: mockCallAiJson,
  AI_SYNC_TIMEOUT_MS: 30_000,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

import { generateSuiteCardPromptsAction } from "@/server/actions/product-v2"
import { regenerateSuiteCardPromptAction } from "@/server/actions/product-v2"

const foreignUrl = `https://app.example.com/uploads/${ENT_B}/image/2026/11/x.png`
const ownUrl = `https://app.example.com/uploads/${ENT_A}/image/2026/11/x.png`

function suiteInput(referenceImages: string[]) {
  return {
    platform: "temu",
    language: "zh",
    referenceImages,
    sellingPoints: "商品卖点",
    cards: [{ directionKey: "main" }],
  }
}

beforeEach(() => {
  mockConsume.mockClear()
  mockCallAiJson.mockClear()
})

describe("出卡参考图归属校验", () => {
  it("批量出卡：他企业 uploads URL → 拒绝且不触达 AI 调用", async () => {
    const res = await generateSuiteCardPromptsAction(suiteInput([foreignUrl]))
    expect(res.ok).toBe(false)
    expect(res.error).toContain("本企业")
    expect(mockCallAiJson).not.toHaveBeenCalled()
  })

  it("单卡重试：他企业 uploads URL → 拒绝且不触达 AI 调用", async () => {
    const res = await regenerateSuiteCardPromptAction({
      ...suiteInput([foreignUrl]),
      card: { directionKey: "main" },
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("本企业")
    expect(mockCallAiJson).not.toHaveBeenCalled()
  })

  it("本企业 URL 不被误杀（放行后落在限流兜底，非归属拒绝）", async () => {
    const res = await generateSuiteCardPromptsAction(suiteInput([ownUrl]))
    expect(res.ok).toBe(false)
    expect(res.error).toBe("操作过于频繁，请稍后再试") // 已过归属校验
    expect(mockCallAiJson).not.toHaveBeenCalled()
  })
})
