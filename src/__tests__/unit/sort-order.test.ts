import { describe, it, expect } from "vitest"
import { allocateSortValues } from "@/server/services/sort-order"

/**
 * 拖拽排序值重分配单测
 *
 * 关键场景：批次内存量重复值（旧表单默认 ?? 99 成片、或从未配置全 0）
 * 时仍需严格递增，否则并列行的先后落到 tiebreak 上、拖拽顺序不落库。
 */
describe("allocateSortValues", () => {
  it("无重复：去重升序原样回填", () => {
    expect(allocateSortValues([30, 10, 20], 3)).toEqual([10, 20, 30])
  })

  it("部分重复（存量 99 成片）：超出部分从最大值继续 +1，严格递增", () => {
    expect(allocateSortValues([99, 0, 99, 99], 4)).toEqual([0, 99, 100, 101])
  })

  it("部分重复且重复值不在最大端", () => {
    expect(allocateSortValues([5, 5, 20, 10], 4)).toEqual([5, 10, 20, 21])
  })

  it("全同值：以该值为基准连续递增（全 0 即 0..n，与未配置表的初始回填一致）", () => {
    expect(allocateSortValues([0, 0, 0], 3)).toEqual([0, 1, 2])
    expect(allocateSortValues([99, 99], 3)).toEqual([99, 100, 101])
  })

  it("空存量：按 0 起步连续递增", () => {
    expect(allocateSortValues([], 3)).toEqual([0, 1, 2])
  })

  it("count = 0 → 空数组", () => {
    expect(allocateSortValues([5, 5], 0)).toEqual([])
  })

  it("所有产出严格递增（扫全部场景）", () => {
    const cases: number[][] = [
      [1],
      [7, 7, 7, 7],
      [3, 3, 8, 8, 12],
      [0, 99],
      [42, 42, 42, 43],
    ]
    for (const existing of cases) {
      const out = allocateSortValues(existing, existing.length)
      for (let i = 1; i < out.length; i++) {
        expect(out[i]).toBeGreaterThan(out[i - 1]!)
      }
    }
  })
})
