import { describe, expect, it } from "vitest"
import {
  MAX_PACKAGES_PER_ORDER,
  packageTotals,
  parsePerPackage,
  splitPackages,
} from "@/components/temu/ship-package-split"

describe("splitPackages（定长拆箱：前包满装、尾包裹余数）", () => {
  it("整除：每包满装", () => {
    expect(splitPackages({ 1: 30 }, 10)).toEqual([{ 1: 10 }, { 1: 10 }, { 1: 10 }])
  })

  it("有余数：尾包裹为余数，每 SKU 合计=发货数", () => {
    expect(splitPackages({ 1: 25 }, 10)).toEqual([{ 1: 10 }, { 1: 10 }, { 1: 5 }])
  })

  it("多 SKU：按最大箱数对齐，第 i 箱合并为第 i 包", () => {
    expect(splitPackages({ 1: 25, 2: 10 }, 10)).toEqual([
      { 1: 10, 2: 10 },
      { 1: 10 },
      { 1: 5 },
    ])
  })

  it("per 为空 / <=0：整单一包", () => {
    expect(splitPackages({ 1: 25, 2: 3 }, null)).toEqual([{ 1: 25, 2: 3 }])
    expect(splitPackages({ 1: 25 }, 0)).toEqual([{ 1: 25 }])
  })

  it("超过 10 包返回 null（官方上限，调用方阻断）", () => {
    expect(splitPackages({ 1: 101 }, 10)).toBeNull()
    expect(splitPackages({ 1: MAX_PACKAGES_PER_ORDER * 10 }, 10)).toHaveLength(MAX_PACKAGES_PER_ORDER)
  })
})

describe("parsePerPackage（「每包件数」输入值）", () => {
  it("空串 / 非法 / <1 → null（整单一包）", () => {
    expect(parsePerPackage("")).toBeNull()
    expect(parsePerPackage("  ")).toBeNull()
    expect(parsePerPackage(undefined)).toBeNull()
    expect(parsePerPackage("abc")).toBeNull()
    expect(parsePerPackage("0")).toBeNull()
    expect(parsePerPackage("-3")).toBeNull()
  })

  it("小数向下取整", () => {
    expect(parsePerPackage("10.9")).toBe(10)
    expect(parsePerPackage("12")).toBe(12)
  })
})

describe("packageTotals（每包总件数序列）", () => {
  it("多 SKU 包按包内件数求和；null 返回空数组", () => {
    expect(packageTotals([{ 1: 10, 2: 5 }, { 1: 3 }])).toEqual([15, 3])
    expect(packageTotals(null)).toEqual([])
  })
})
