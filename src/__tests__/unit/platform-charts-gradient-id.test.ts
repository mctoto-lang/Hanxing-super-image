import { describe, it, expect, vi } from "vitest"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MultiSeriesAreaChart } from "@/components/platform/charts"

// node 环境下 ResponsiveContainer / recharts 3 的图表均依赖挂载期尺寸测量，
// renderToStaticMarkup 不输出 children。渐变 id 生成在组件自身，故将
// ChartContainer 与 recharts 的 AreaChart/Area 透传渲染（其余导出保留），
// 使测试聚焦渐变 id 生成（本 bug 的根因）。
vi.mock("@/components/ui/chart", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/ui/chart")>()
  return {
    ...actual,
    ChartContainer: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
  }
})

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>()
  return {
    ...actual,
    AreaChart: (props: { children?: React.ReactNode }) =>
      React.createElement("svg", null, props.children),
    Area: (props: { fill?: string; dataKey?: string }) =>
      React.createElement("path", {
        fill: props.fill,
        "data-key": props.dataKey,
      }),
  }
})

/**
 * MultiSeriesAreaChart 渐变 id 实例唯一性（回归测试）
 *
 * 平台数据看板同页无条件同时渲染两个本组件（积分消耗趋势 series=[amount]、
 * 用户/企业增长 series=[users, enterprises]）。若渐变 id 用与实例无关的字面量
 * （fillSeries0），同文档重复 id 会让增长图的 url(#fillSeries0) 按文档树序
 * 解析到积分消耗图的渐变，面积填充取错色。此测试渲染两个实例，断言渐变 id
 * 无交集且各 Area 引用自身实例的渐变。
 */

/** 提取渲染输出中的 linearGradient id 与 Area 的 fill url(#) 引用 */
function extractGradientRefs(html: string) {
  const gradientIds = [
    ...html.matchAll(/<linearGradient[^>]*\bid="([^"]+)"/g),
  ].map((m) => m[1])
  const fillRefs = [...html.matchAll(/fill="url\(#([^)]+)\)"/g)].map(
    (m) => m[1],
  )
  return { gradientIds, fillRefs }
}

const creditsChart = React.createElement(MultiSeriesAreaChart, {
  data: [
    { day: "2026-11-01", amount: 10 },
    { day: "2026-11-02", amount: 20 },
  ],
  series: [{ key: "amount", label: "积分消耗" }],
})

const growthChart = React.createElement(MultiSeriesAreaChart, {
  data: [
    { day: "2026-11-01", users: 3, enterprises: 1 },
    { day: "2026-11-02", users: 5, enterprises: 2 },
  ],
  series: [
    { key: "users", label: "新增用户", color: "var(--chart-2)" },
    { key: "enterprises", label: "新增企业", color: "var(--chart-3)" },
  ],
})

describe("MultiSeriesAreaChart 渐变 id 实例唯一", () => {
  it("同页两个实例的渐变 id 无交集（不再共用 fillSeries0）", () => {
    // 模拟 platform/page.tsx 两卡同页渲染（拼进同一文档）
    const html = renderToStaticMarkup(
      React.createElement("div", null, creditsChart, growthChart),
    )
    const { gradientIds, fillRefs } = extractGradientRefs(html)

    // 前置：SSR 输出确实包含渐变与面积引用，否则断言无意义
    expect(gradientIds.length).toBeGreaterThan(0)
    expect(fillRefs.length).toBeGreaterThan(0)

    // 同一文档内渐变 id 不得重复
    expect(new Set(gradientIds).size).toBe(gradientIds.length)
    // 每个 url(#) 引用都有本文档内定义的渐变与之对应
    for (const ref of fillRefs) {
      expect(gradientIds).toContain(ref)
    }
    // 不应再出现与实例无关的字面量 id
    expect(gradientIds).not.toContain("fillSeries0")
  })

  it("单实例内每个序列的渐变 id 含 series key，且引用一一对应", () => {
    const html = renderToStaticMarkup(growthChart)
    const { gradientIds, fillRefs } = extractGradientRefs(html)

    expect(gradientIds.length).toBe(2)
    expect(fillRefs.length).toBe(2)
    // 渐变按 series key 区分，Area 的 fill 引用与渐变定义一致
    for (const key of ["users", "enterprises"]) {
      const id = gradientIds.find((g) => g.endsWith(`-fill-${key}`))
      expect(id, `缺少 ${key} 的渐变`).toBeTruthy()
      expect(fillRefs).toContain(id)
    }
  })
})
