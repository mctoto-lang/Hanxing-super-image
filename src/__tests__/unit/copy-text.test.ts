import { describe, it, expect, vi, afterEach } from "vitest"
import { copyText } from "@/lib/utils"

/**
 * 剪贴板复制单测：
 * navigator.clipboard 仅安全上下文（HTTPS/localhost）可用，HTTP 线上为
 * undefined（复制按钮曾静默失效/假报成功）。验证主路径与 execCommand 兜底
 * 的降级链路（node 环境，document 用手写桩模拟）。
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 手写最小 document 桩：createElement(textarea) + body + selection + execCommand */
function stubDocument(execOk: boolean) {
  const textareas: Array<{ value: string }> = []
  const doc = {
    createElement: (_tag: string) => {
      const ta = {
        value: "",
        style: {},
        setAttribute: vi.fn(),
        select: vi.fn(),
        setSelectionRange: vi.fn(),
      }
      textareas.push(ta)
      return ta
    },
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
    getSelection: () => ({ rangeCount: 0, removeAllRanges: vi.fn(), addRange: vi.fn() }),
    execCommand: vi.fn(() => execOk),
  }
  vi.stubGlobal("document", doc)
  return { doc, textareas }
}

describe("copyText 降级链路", () => {
  it("安全上下文：clipboard 可用且成功 → true，不触碰 execCommand", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    const { doc } = stubDocument(true)
    await expect(copyText("hello")).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith("hello")
    expect(doc.execCommand).not.toHaveBeenCalled()
  })

  it("clipboard 被拒（权限/失焦）→ 落入 execCommand 兜底成功", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    })
    const { doc } = stubDocument(true)
    await expect(copyText("hello")).resolves.toBe(true)
    expect(doc.execCommand).toHaveBeenCalledWith("copy")
  })

  it("HTTP 非安全上下文：无 clipboard → execCommand 兜底，文本已写入 textarea", async () => {
    vi.stubGlobal("navigator", {}) // 无 clipboard 属性
    const { doc, textareas } = stubDocument(true)
    await expect(copyText("hello http")).resolves.toBe(true)
    expect(textareas[0]!.value).toBe("hello http")
    expect(doc.execCommand).toHaveBeenCalledWith("copy")
  })

  it("execCommand 返回 false → 如实返回 false（调用方提示失败）", async () => {
    vi.stubGlobal("navigator", {})
    stubDocument(false)
    await expect(copyText("hello")).resolves.toBe(false)
  })

  it("无 clipboard 且无 document（SSR 等）→ 不抛错，返回 false", async () => {
    vi.stubGlobal("navigator", {})
    vi.stubGlobal("document", undefined)
    await expect(copyText("hello")).resolves.toBe(false)
  })
})
