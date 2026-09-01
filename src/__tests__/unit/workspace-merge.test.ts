import { describe, it, expect } from "vitest"
import {
  findCountMismatch,
  mergeImageRows,
  sameCardDisplay,
  sameImageRow,
} from "@/lib/workspace/helpers"
import { toImageSrc, stripCosThumbnail } from "@/lib/utils"
import type {
  CardImageRow,
  PromptCardRow,
  TaskCardImagesPayload,
} from "@/lib/workspace/types"

/**
 * 轮询合并身份稳定性单测：增量轮询下未变化的行/卡片必须复用旧对象引用，
 * 否则 FlipCard 的 memo 每轮失效，100 卡每 3 秒全量重渲染。
 */

function makeImageRow(overrides: Partial<CardImageRow> = {}): CardImageRow {
  return {
    id: "img-1",
    cardId: "card-1",
    generationTaskId: "task-1",
    generationPrompt: "a cat",
    imageApiId: "model-1",
    imageUrl: "https://bucket.cos.ap-guangzhou.myqcloud.com/image/a.png",
    modelName: "Test Model",
    size: "1024x1024",
    format: "png",
    status: "pending",
    errorMessage: null,
    isSelected: false,
    source: "generated",
    generationStartedAt: new Date("2026-01-01T00:00:00Z"),
    generationCompletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  }
}

function makeCard(overrides: Partial<PromptCardRow> = {}): PromptCardRow {
  return {
    id: "card-1",
    taskId: "task-1",
    cardIndex: 0,
    prompt: "a cat",
    translatedPrompt: null,
    translationSourcePrompt: null,
    translationStatus: "none",
    translationTemplateId: null,
    displayLanguage: "zh",
    selectedImageId: null,
    referenceImages: [],
    selImgId: null,
    selImgUrl: null,
    selImgModelName: null,
    selImgSize: null,
    selImgStartedAt: null,
    selImgCompletedAt: null,
    selImgCreatedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  }
}

describe("mergeImageRows", () => {
  it("全量模式直接采用 payload 行", () => {
    const prev = [makeImageRow()]
    const payloadRows = [makeImageRow({ id: "img-2" })]
    expect(mergeImageRows(prev, payloadRows, false)).toBe(payloadRows)
  })

  it("无历史（首轮）直接采用 payload 行", () => {
    const payloadRows = [makeImageRow()]
    expect(mergeImageRows(undefined, payloadRows, true)).toBe(payloadRows)
  })

  it("增量为空时返回原数组引用", () => {
    const prev = [makeImageRow()]
    expect(mergeImageRows(prev, [], true)).toBe(prev)
  })

  it("内容未变的重发行（如选中行）保留原数组与原行引用", () => {
    const row = makeImageRow({ status: "completed", isSelected: true })
    const prev = [row]
    // 服务端每轮重发选中行：新对象、同内容
    const resent = makeImageRow({
      status: "completed",
      isSelected: true,
      generationCompletedAt: new Date("2026-01-01T00:00:01Z"),
    })
    const resentSame = makeImageRow({ ...row, isSelected: true })
    // 内容完全一致的新实例
    const clone = makeImageRow({ ...row })
    const result = mergeImageRows(prev, [clone], true)
    expect(result).toBe(prev)
    expect(result[0]).toBe(row)
    expect(resent).toBeDefined()
    expect(resentSame).toBeDefined()
  })

  it("状态变化的行被替换，其余行保留引用", () => {
    const rowA = makeImageRow({ id: "a" })
    const rowB = makeImageRow({ id: "b" })
    const prev = [rowA, rowB]
    const changed = makeImageRow({
      id: "a",
      status: "completed",
      imageUrl: "https://bucket.cos.ap-guangzhou.myqcloud.com/image/done.png",
      generationCompletedAt: new Date("2026-01-01T00:00:05Z"),
    })
    const result = mergeImageRows(prev, [changed], true)
    expect(result).not.toBe(prev)
    expect(result.find((r) => r.id === "a")).toBe(changed)
    expect(result.find((r) => r.id === "b")).toBe(rowB)
  })

  it("新增行按 createdAt 倒序插入", () => {
    const old = makeImageRow({ id: "old", createdAt: new Date("2026-01-01T00:00:00Z") })
    const prev = [old]
    const fresh = makeImageRow({
      id: "fresh",
      createdAt: new Date("2026-01-01T00:01:00Z"),
    })
    const result = mergeImageRows(prev, [fresh], true)
    expect(result.map((r) => r.id)).toEqual(["fresh", "old"])
  })
})

describe("sameImageRow", () => {
  it("同内容不同实例视为一致", () => {
    const a = makeImageRow()
    const b = makeImageRow()
    expect(a).not.toBe(b)
    expect(sameImageRow(a, b)).toBe(true)
  })

  it("status 变化视为不一致", () => {
    expect(
      sameImageRow(makeImageRow(), makeImageRow({ status: "failed" })),
    ).toBe(false)
  })

  it("Date 字段同时间不同实例视为一致", () => {
    expect(
      sameImageRow(
        makeImageRow({ generationStartedAt: new Date("2026-01-01T00:00:00Z") }),
        makeImageRow({ generationStartedAt: new Date("2026-01-01T00:00:00Z") }),
      ),
    ).toBe(true)
  })
})

describe("sameCardDisplay", () => {
  it("同内容不同实例（含 Date）视为一致", () => {
    const a = makeCard()
    const b = makeCard({
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    })
    expect(sameCardDisplay(a, b)).toBe(true)
  })

  it("prompt 变化视为不一致", () => {
    expect(sameCardDisplay(makeCard(), makeCard({ prompt: "a dog" }))).toBe(
      false,
    )
  })

  it("选中图变化视为不一致", () => {
    expect(
      sameCardDisplay(makeCard(), makeCard({ selImgUrl: "https://x/y.png" })),
    ).toBe(false)
  })
})

describe("findCountMismatch", () => {
  const payload = (cards: TaskCardImagesPayload["cards"]): TaskCardImagesPayload => ({
    cards,
  })

  it("本地与服务端计数一致时返回空", () => {
    const p = payload({
      "card-1": {
        cardId: "card-1",
        pendingCount: 0,
        completedCount: 1,
        failedCount: 0,
        images: [],
      },
    })
    const map = new Map([
      ["card-1", [makeImageRow({ id: "a", status: "completed" })]],
    ])
    expect(findCountMismatch(p, map)).toEqual([])
  })

  it("典型丢行：服务端 pending=0 但本地残留 pending 行 → 报告该卡", () => {
    const p = payload({
      "card-1": {
        cardId: "card-1",
        pendingCount: 0,
        completedCount: 1,
        failedCount: 0,
        images: [],
      },
    })
    const map = new Map([
      ["card-1", [makeImageRow({ id: "a", status: "pending" })]],
    ])
    expect(findCountMismatch(p, map)).toEqual(["card-1"])
  })

  it("本地比服务端多一行（completed 计数落后）→ 报告该卡", () => {
    const p = payload({
      "card-1": {
        cardId: "card-1",
        pendingCount: 0,
        completedCount: 2,
        failedCount: 0,
        images: [],
      },
    })
    const map = new Map([
      [
        "card-1",
        [
          makeImageRow({ id: "a", status: "completed" }),
          makeImageRow({ id: "b", status: "pending" }),
        ],
      ],
    ])
    expect(findCountMismatch(p, map)).toEqual(["card-1"])
  })

  it("多卡混合：只报告不一致的卡", () => {
    const p = payload({
      "card-1": {
        cardId: "card-1",
        pendingCount: 1,
        completedCount: 0,
        failedCount: 0,
        images: [],
      },
      "card-2": {
        cardId: "card-2",
        pendingCount: 0,
        completedCount: 1,
        failedCount: 1,
        images: [],
      },
    })
    const map = new Map([
      ["card-1", [makeImageRow({ id: "a", status: "pending" })]],
      [
        "card-2",
        [
          makeImageRow({ id: "b", status: "completed" }),
          makeImageRow({ id: "c", status: "failed" }),
        ],
      ],
      // card-3 不在 payload 里：不参与对账
      ["card-3", [makeImageRow({ id: "d", status: "pending" })]],
    ])
    expect(findCountMismatch(p, map)).toEqual([])
  })

  it("payload 中有而本地完全缺失的卡（map 无条目）→ 报告", () => {
    const p = payload({
      "card-1": {
        cardId: "card-1",
        pendingCount: 0,
        completedCount: 1,
        failedCount: 0,
        images: [],
      },
    })
    expect(findCountMismatch(p, new Map())).toEqual(["card-1"])
  })
})

describe("toImageSrc / stripCosThumbnail", () => {
  const cosUrl = "https://bucket-1250000.cos.ap-guangzhou.myqcloud.com/image/a.png"

  it("COS URL 指定 width 时追加缩略参数", () => {
    expect(toImageSrc(cosUrl, { width: 400 })).toBe(
      `${cosUrl}?imageMogr2/thumbnail/400x`,
    )
  })

  it("COS URL 已有 query 时用 & 拼接", () => {
    expect(toImageSrc(`${cosUrl}?t=1`, { width: 400 })).toBe(
      `${cosUrl}?t=1&imageMogr2/thumbnail/400x`,
    )
  })

  it("COS URL 未指定 width 原样返回（大图查看场景）", () => {
    expect(toImageSrc(cosUrl)).toBe(cosUrl)
  })

  it("已含 imageMogr2 时不重复追加", () => {
    const withCi = `${cosUrl}?imageMogr2/thumbnail/400x`
    expect(toImageSrc(withCi, { width: 400 })).toBe(withCi)
  })

  it("非 COS 远程 URL 走代理并带 width 参数", () => {
    expect(toImageSrc("https://example.com/a.png", { width: 300 })).toBe(
      "/api/image/proxy?url=https%3A%2F%2Fexample.com%2Fa.png&width=300",
    )
  })

  it("本地 /uploads 路径原样返回", () => {
    expect(toImageSrc("/uploads/ent/a.png", { width: 300 })).toBe(
      "/uploads/ent/a.png",
    )
  })

  it("stripCosThumbnail 去掉追加的缩略参数", () => {
    expect(stripCosThumbnail(`${cosUrl}?imageMogr2/thumbnail/400x`)).toBe(cosUrl)
    expect(stripCosThumbnail(`${cosUrl}?t=1&imageMogr2/thumbnail/400x`)).toBe(
      `${cosUrl}?t=1`,
    )
    expect(stripCosThumbnail(cosUrl)).toBe(cosUrl)
  })
})
