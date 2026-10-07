import { describe, expect, it } from "vitest"
import {
  isContentPolicyError,
  summarizeImageErrors,
  type ImageGenResult,
} from "@/lib/ai/image-model-config"

/**
 * summarizeImageErrors 回归测试：callImageApi 对单张失败不抛异常
 * （{index, error} 部分成功语义），失败原因必须能从这里取回——
 * 否则重试收尾的报错只剩「未知原因」，无法定位上游问题。
 *
 * isContentPolicyError：内容安全拒绝（可改写规避）与纯调用失败
 * （过载/超时，重试即可）必须区分——只有前者应触发打回改写。
 */

describe("summarizeImageErrors", () => {
  it("全部成功返回 null", () => {
    const results: ImageGenResult[] = [
      { index: 0, url: "https://cdn.example/a.png" },
      { index: 1, url: "https://cdn.example/b.png" },
    ]
    expect(summarizeImageErrors(results)).toBeNull()
  })

  it("混排成败只汇总失败张的上游错误", () => {
    const results: ImageGenResult[] = [
      { index: 0, url: "https://cdn.example/a.png" },
      { index: 1, error: "上游 429：rate limited" },
    ]
    expect(summarizeImageErrors(results)).toBe("上游 429：rate limited")
  })

  it("相同错误去重（多张同因失败只保留一条）", () => {
    const results: ImageGenResult[] = [
      { index: 0, error: "上游 401：invalid api key" },
      { index: 1, error: "上游 401：invalid api key" },
    ]
    expect(summarizeImageErrors(results)).toBe("上游 401：invalid api key")
  })

  it("不同错误拼接；超过 3 类时限量并注明总数", () => {
    const results: ImageGenResult[] = [
      { index: 0, error: "E1" },
      { index: 1, error: "E2" },
      { index: 2, error: "E3" },
      { index: 3, error: "E4" },
    ]
    expect(summarizeImageErrors(results)).toBe("E1；E2；E3；等共 4 类错误")
  })

  it("单条超长截断到 400 字符；空白错误忽略", () => {
    const long = "x".repeat(600)
    const results: ImageGenResult[] = [
      { index: 0, error: long },
      { index: 1, error: "   " },
      { index: 2 },
    ]
    const summary = summarizeImageErrors(results)!
    expect(summary.length).toBe(400)
    expect(summary).toBe("x".repeat(400))
  })

  it("空数组 / 无失败张返回 null", () => {
    expect(summarizeImageErrors([])).toBeNull()
    expect(summarizeImageErrors([{ index: 0 }, { index: 1, error: "" }])).toBeNull()
  })
})

describe("isContentPolicyError", () => {
  it.each([
    ["OpenAI: Your request was rejected as a result of our safety system", "英文 safety system"],
    ["upstream 400: content_policy_violation (trigger: gore)", "content_policy 连写"],
    ["error code: 400 - Your prompt was flagged by our content policy", "content policy 分写"],
    ["Request violates usage policy: sexually explicit content", "色情拒绝"],
    ["该图片生成请求包含违规内容，已被内容安全策略拦截", "中文违规内容"],
    ["画面包含敏感内容，审核不通过", "中文敏感内容"],
    ["image blocked: prohibited content detected", "prohibited"],
  ])("内容拒绝类错误应匹配：%s", (message) => {
    expect(isContentPolicyError(message)).toBe(true)
  })

  it.each([
    ["生图失败（已重试 2 次，费用已退还）：上游 429: rate limited, too many requests", "限流"],
    ["upstream 503: service overloaded, please retry later", "过载"],
    ["生图超过任务超时预算（600s）", "超时"],
    ["fetch failed: connection reset by peer", "网络中断"],
    ["上游 401: invalid api key", "鉴权失败"],
    ["未知原因", "无信息"],
    ["", "空串"],
  ])("纯调用失败类错误不应匹配（不触发改写）：%s", (message) => {
    expect(isContentPolicyError(message)).toBe(false)
  })
})
