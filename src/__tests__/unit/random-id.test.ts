import { describe, it, expect, afterEach, vi } from "vitest"
import { randomId } from "@/lib/utils"

/**
 * 客户端随机 id 单测：
 * crypto.randomUUID 仅安全上下文（HTTPS/localhost）可用，HTTP 线上环境为
 * undefined（图片库上传曾因此把成功上传误报为失败）。验证三级回退：
 * randomUUID → getRandomValues 拼 UUID v4 → Date+Math.random 兜底。
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("randomId 三级回退", () => {
  it("原生 randomUUID 可用 → 标准 UUID v4", () => {
    // vitest node 环境（Node 22）自带 randomUUID
    expect(randomId()).toMatch(UUID_RE)
  })

  it("仅 getRandomValues 可用（HTTP 非安全上下文）→ 仍产出 UUID v4", () => {
    // 模拟非安全上下文：crypto 对象上没有 randomUUID，仅剩 getRandomValues
    // （先捕获真实实现，stubGlobal 后 globalThis.crypto 已是替换对象）
    const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
    vi.stubGlobal("crypto", {
      getRandomValues: (arr: Uint8Array) => real(arr),
    })
    expect(randomId()).toMatch(UUID_RE)
    // 两次调用不重复
    expect(randomId()).not.toBe(randomId())
  })

  it("crypto 完全不可用（极老浏览器）→ Date+random 兜底，不抛错", () => {
    vi.stubGlobal("crypto", undefined)
    const id = randomId()
    expect(id).toMatch(/^id-\d+-[0-9a-z]+$/)
  })
})
