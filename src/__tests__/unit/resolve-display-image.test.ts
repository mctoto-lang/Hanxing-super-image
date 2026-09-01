import { describe, it, expect } from "vitest"
import { resolveCardDisplayImage } from "@/lib/workspace/helpers"
import type { CardImageRow } from "@/lib/workspace/types"

/**
 * resolveCardDisplayImage 单测：卡片展示图三级回退链
 * （selectedImageId 命中 → isSelected → 首张已完成），导出与卡片正面共用。
 */

let seq = 0
function makeImage(overrides: Partial<CardImageRow> = {}): CardImageRow {
  seq += 1
  return {
    id: `img-${seq}`,
    cardId: "card-1",
    generationTaskId: null,
    generationPrompt: null,
    imageApiId: null,
    imageUrl: `https://cos/${seq}.png`,
    modelName: null,
    size: "1024x1024",
    format: "png",
    status: "completed",
    errorMessage: null,
    isSelected: false,
    source: "generated",
    generationStartedAt: null,
    generationCompletedAt: null,
    createdAt: new Date(),
    ...overrides,
  }
}

describe("resolveCardDisplayImage 展示图回退链", () => {
  it("selectedImageId 命中：优先返回选中行（即使排在列表后面）", () => {
    const a = makeImage()
    const b = makeImage({ isSelected: true })
    const pick = resolveCardDisplayImage({ selectedImageId: a.id }, [b, a])
    expect(pick?.id).toBe(a.id)
  })

  it("selectedImageId 未命中：回退到 isSelected 标记的行", () => {
    const a = makeImage()
    const b = makeImage({ isSelected: true })
    const pick = resolveCardDisplayImage({ selectedImageId: null }, [a, b])
    expect(pick?.id).toBe(b.id)
  })

  it("均未选中（存量数据场景）：回退到首张有 URL 的已完成图", () => {
    // 模拟生成完成但从未选图的卡片：50 张卡片导出不再被误判为无图
    const pending = makeImage({ status: "pending", imageUrl: "" })
    const failed = makeImage({ status: "failed" })
    const completedOldest = makeImage()
    const completedNewest = makeImage()
    const pick = resolveCardDisplayImage(
      { selectedImageId: null },
      [pending, failed, completedOldest, completedNewest],
    )
    expect(pick?.id).toBe(completedOldest.id) // 列表首个已完成（createdAt 降序时即最新）
  })

  it("selectedImageId 指向的行无 URL 时跳过，回退到已完成图", () => {
    const broken = makeImage({ imageUrl: "" })
    const ok = makeImage()
    const pick = resolveCardDisplayImage({ selectedImageId: broken.id }, [
      broken,
      ok,
    ])
    expect(pick?.id).toBe(ok.id)
  })

  it("上传图（source=uploaded）也可作为回退（与卡片正面展示一致）", () => {
    const uploaded = makeImage({ source: "uploaded" })
    const pick = resolveCardDisplayImage({ selectedImageId: null }, [uploaded])
    expect(pick?.id).toBe(uploaded.id)
  })

  it("无任何可用图片时返回 null", () => {
    expect(
      resolveCardDisplayImage({ selectedImageId: null }, []),
    ).toBeNull()
    expect(
      resolveCardDisplayImage(
        { selectedImageId: null },
        [makeImage({ status: "failed" }), makeImage({ status: "pending" })],
      ),
    ).toBeNull()
  })
})
