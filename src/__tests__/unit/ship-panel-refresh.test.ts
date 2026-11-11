import { describe, expect, it } from "vitest"
import { pickPrintLockedRows, shipListLoadOpts } from "@/components/temu/ship-panel-refresh"

describe("shipListLoadOpts（发货单列表重查触发口径）", () => {
  it("进入/切回「发货单列表」视图（含首次）：拉实时单（fresh）", () => {
    expect(shipListLoadOpts(null, "orders")).toEqual({ fresh: true })
    expect(shipListLoadOpts("staging", "orders")).toEqual({ fresh: true })
  })

  it("视图内 load 身份变化（翻页/筛选/搜索/reloadTick/切店）：本地重查（非 fresh）", () => {
    expect(shipListLoadOpts("orders", "orders")).toEqual({ fresh: false })
  })

  it("发货台视图不拉列表数据", () => {
    expect(shipListLoadOpts("orders", "staging")).toBeNull()
    expect(shipListLoadOpts(null, "staging")).toBeNull()
    expect(shipListLoadOpts("staging", "staging")).toBeNull()
  })
})

describe("pickPrintLockedRows（打印锁定直弹取刷新后的行）", () => {
  const row = (sn: string, over: Partial<{ status: number; isPrintBoxMark: boolean | null }> = {}) => ({
    deliveryOrderSn: sn,
    status: 0,
    isPrintBoxMark: true,
    ...over,
  })

  it("按单号取刷新后的行：打印后回填的多箱单（packageSns/deliverPackageNum）原样带入弹窗", () => {
    const fresh = [
      row("SN-1", { isPrintBoxMark: true }),
      row("SN-2", { isPrintBoxMark: true }),
      row("SN-9"),
    ]
    const picked = pickPrintLockedRows(fresh, ["SN-2", "SN-1"])
    expect(picked.rows.map((r) => r.deliveryOrderSn)).toEqual(["SN-1", "SN-2"])
    expect(picked.missingSns).toEqual([])
  })

  it("剔除未锁定打印 / 已非待装箱的单，missingSns 报缺失", () => {
    const fresh = [
      row("SN-1", { isPrintBoxMark: null }), // 官方未回填锁定标记
      row("SN-2", { status: 1 }), // 已被装箱发货
      row("SN-3"),
    ]
    const picked = pickPrintLockedRows(fresh, ["SN-1", "SN-2", "SN-3"])
    expect(picked.rows.map((r) => r.deliveryOrderSn)).toEqual(["SN-3"])
    expect(picked.missingSns).toEqual(["SN-1", "SN-2"])
  })

  it("目标单不在刷新后的当前页：rows 为空、全部计入 missingSns（调用方提示并不再开弹窗）", () => {
    const picked = pickPrintLockedRows([row("SN-8")], ["SN-1", "SN-2"])
    expect(picked.rows).toEqual([])
    expect(picked.missingSns).toEqual(["SN-1", "SN-2"])
  })
})
