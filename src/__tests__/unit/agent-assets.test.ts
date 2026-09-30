import { describe, it, expect } from "vitest"
import {
  AGENT_ASSET_KINDS,
  AGENT_ASSET_KIND_META,
  BOX_ASSET_REFERENCE_ORDER,
  isAgentAssetKind,
  orderBoxAssets,
  validatePngAlpha,
} from "@/lib/agent/assets"

/**
 * Agent 固定资产工具单测（纯函数部分）：
 * kind 常量契约、牌盒参考图排序、sharp 不可用/非法输入时的结构化降级
 * （不抛错，返回 reason，方便 worker 流水线跳过而不中断）。
 */

describe("AGENT_ASSET_KINDS", () => {
  it("固定六种资产（边框/卡背/牌盒四面）", () => {
    expect([...AGENT_ASSET_KINDS]).toEqual([
      "border",
      "back",
      "box_front",
      "box_back",
      "box_side",
      "box_top",
    ])
  })

  it("meta 分组与透明度要求：border 必须 alpha，其余整幅画面", () => {
    expect(AGENT_ASSET_KIND_META.border.group).toBe("card")
    expect(AGENT_ASSET_KIND_META.border.requiresAlpha).toBe(true)
    expect(AGENT_ASSET_KIND_META.back.group).toBe("card")
    for (const kind of ["box_front", "box_back", "box_side", "box_top"] as const) {
      expect(AGENT_ASSET_KIND_META[kind].group).toBe("box")
      expect(AGENT_ASSET_KIND_META[kind].requiresAlpha).toBe(false)
    }
  })

  it("isAgentAssetKind 防御脏数据", () => {
    expect(isAgentAssetKind("border")).toBe(true)
    expect(isAgentAssetKind("box_top")).toBe(true)
    expect(isAgentAssetKind("cover")).toBe(false)
    expect(isAgentAssetKind(null)).toBe(false)
    expect(isAgentAssetKind(42)).toBe(false)
  })
})

describe("orderBoxAssets", () => {
  it("按 正面→背面→侧面→顶面 固定顺序重排", () => {
    const ordered = orderBoxAssets([
      { kind: "box_top", url: "u4" },
      { kind: "box_side", url: "u3" },
      { kind: "box_front", url: "u1" },
      { kind: "box_back", url: "u2" },
    ])
    expect(ordered.map((a) => a.kind)).toEqual([
      "box_front",
      "box_back",
      "box_side",
      "box_top",
    ])
    expect(ordered.map((a) => a.url)).toEqual(["u1", "u2", "u3", "u4"])
  })

  it("与 BOX_ASSET_REFERENCE_ORDER 一致；同 kind 保持稳定", () => {
    const input = [
      { kind: "box_side", n: 1 },
      { kind: "box_front", n: 2 },
      { kind: "box_side", n: 3 },
    ]
    const ordered = orderBoxAssets(input)
    expect(ordered.map((a) => a.kind)).toEqual(["box_front", "box_side", "box_side"])
    expect(ordered.map((a) => a.n)).toEqual([2, 1, 3])
  })

  it("未登记 kind 排在已登记之后（保持相对顺序）", () => {
    const ordered = orderBoxAssets([
      { kind: "border" },
      { kind: "box_front" },
      { kind: "back" },
    ])
    expect(ordered.map((a) => a.kind)).toEqual(["box_front", "border", "back"])
  })

  it("空输入返回空数组", () => {
    expect(orderBoxAssets([])).toEqual([])
  })

  it("BOX_ASSET_REFERENCE_ORDER 覆盖全部牌盒 kind", () => {
    expect([...BOX_ASSET_REFERENCE_ORDER]).toEqual([
      "box_front",
      "box_back",
      "box_side",
      "box_top",
    ])
  })
})

describe("PNG alpha 校验", () => {
  it("非法输入不抛错：validatePngAlpha 返回 ok:false", async () => {
    const result = await validatePngAlpha(Buffer.from("not an image"))
    expect(result.ok).toBe(false)
    if (result.ok === false) expect(["sharp_unavailable", "invalid_image"]).toContain(result.reason)
  })
})
