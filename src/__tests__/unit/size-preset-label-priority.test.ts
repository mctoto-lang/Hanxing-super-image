import { describe, expect, it } from "vitest"

import { resolveSizePresets } from "@/lib/image-sizes"

/**
 * 锁定 2026-11-19 尺寸预设展示口径（配套 0103 迁移 label→ratio）：
 * 显式 ratio 优先（管理员编辑即生效），存量自定义 label 兜底不突变。
 */
describe("resolveSizePresets 展示口径：显式 ratio 优先、存量 label 兜底", () => {
  it("纯比例 label 迁移后由 ratio 承载，展示文案不变", () => {
    const [p] = resolveSizePresets([{ ratio: "16:9", width: 800, height: 600 }])
    expect(p?.label).toBe("16:9")
    expect(p?.ratio).toBe("16:9")
  })

  it("非比例自定义 label 保留，不因 gcd 归约被覆盖", () => {
    const [p] = resolveSizePresets([{ label: "智能", width: 1024, height: 1024 }])
    expect(p?.label).toBe("智能")
  })

  it("存量旧 label 不再遮蔽管理员设置的 ratio（编辑即生效）", () => {
    const [p] = resolveSizePresets([
      { label: "1:1", ratio: "4:3", width: 1024, height: 768 },
    ])
    expect(p?.label).toBe("4:3")
    expect(p?.ratio).toBe("4:3")
  })

  it("label 与 ratio 皆缺时回退宽高 gcd 归约", () => {
    const [p] = resolveSizePresets([{ width: 1280, height: 720 }])
    expect(p?.label).toBe("16:9")
  })
})
