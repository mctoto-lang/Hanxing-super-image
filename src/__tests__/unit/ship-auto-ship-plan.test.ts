import { describe, expect, it } from "vitest"
import {
  UNKNOWN_WAREHOUSE_KEY,
  UNKNOWN_WAREHOUSE_NAME,
  chunk,
  effectivePackageCount,
  groupRowsByWarehouse,
  mapLimit,
  packageCountOf,
  planPackageTotals,
  projectStock,
  type AutoShipPlanRow,
} from "@/components/temu/ship-auto-ship-plan"

const row = (over: Partial<AutoShipPlanRow> = {}): AutoShipPlanRow => ({
  deliveryOrderSn: "SN",
  skcExtCode: "B049",
  deliverSkcNum: 30,
  isPrintBoxMark: null,
  packageSns: [],
  deliverPackageNum: null,
  skuQtys: [{ productSkuId: 111, skuNum: 30 }],
  subWarehouseId: 1,
  subWarehouseName: "广州仓",
  ...over,
})

describe("groupRowsByWarehouse（按收货仓分组）", () => {
  it("保持首现顺序与组内原顺序，同仓归一组", () => {
    const gs = groupRowsByWarehouse([
      row({ deliveryOrderSn: "A", subWarehouseId: 1, subWarehouseName: "广州仓" }),
      row({ deliveryOrderSn: "B", subWarehouseId: 2, subWarehouseName: "成都仓" }),
      row({ deliveryOrderSn: "C", subWarehouseId: 1, subWarehouseName: "广州仓" }),
    ])
    expect(gs.map((g) => [g.name, g.rows.map((r) => r.deliveryOrderSn)])).toEqual([
      ["广州仓", ["A", "C"]],
      ["成都仓", ["B"]],
    ])
  })

  it("缺收货仓名回落「收货仓{id}」；缺收货仓归入未知组（界面阻断）", () => {
    const gs = groupRowsByWarehouse([
      row({ deliveryOrderSn: "A", subWarehouseId: 7, subWarehouseName: null }),
      row({ deliveryOrderSn: "B", subWarehouseId: null, subWarehouseName: null }),
    ])
    expect(gs.map((g) => [g.key, g.name])).toEqual([
      ["7", "收货仓7"],
      [UNKNOWN_WAREHOUSE_KEY, UNKNOWN_WAREHOUSE_NAME],
    ])
  })
})

describe("packageCountOf（每单包裹数）", () => {
  it("官方应发包裹数优先 → 包裹号数 → 兜底 1", () => {
    expect(packageCountOf(row({ deliverPackageNum: 3, packageSns: ["P1", "P2"] }))).toBe(3)
    expect(packageCountOf(row({ deliverPackageNum: 0, packageSns: ["P1", "P2"] }))).toBe(2)
    expect(packageCountOf(row({ packageSns: [] }))).toBe(1)
  })
})

describe("effectivePackageCount（比价/发送/界面统一包裹数口径）", () => {
  it("真实（官方包裹查询条数）>0 优先——查询返回 0/空数组不置 0，回落推算", () => {
    // 官方返回空数组（索引延迟）+ 单据自带 0/空：按装箱数推算而非 0 或 1
    expect(effectivePackageCount(row({ deliverSkcNum: 25, skuQtys: [{ productSkuId: 1, skuNum: 25 }] }), 0, 10)).toBe(3)
    expect(effectivePackageCount(row({ deliverSkcNum: 25, skuQtys: [{ productSkuId: 1, skuNum: 25 }] }), null, 10)).toBe(3)
    expect(effectivePackageCount(row({ deliverSkcNum: 25, skuQtys: [{ productSkuId: 1, skuNum: 25 }] }), undefined, 10)).toBe(3)
    // 真实条数 >0 直接采用
    expect(effectivePackageCount(row({ deliverPackageNum: 3 }), 5, 10)).toBe(5)
  })

  it("官方应发包裹数 / 本地包裹号（>0）先于推算；无档案推算回落整单一包", () => {
    expect(effectivePackageCount(row({ deliverPackageNum: 4, deliverSkcNum: 25 }), null, 10)).toBe(4)
    expect(effectivePackageCount(row({ deliverPackageNum: 0, packageSns: ["P1", "P2"] }), null, 10)).toBe(2)
    expect(effectivePackageCount(row({ deliverSkcNum: 7 }), null, null)).toBe(1)
  })
})

describe("planPackageTotals（未打印单按装箱数推算）", () => {
  it("按库存档案装箱数定长拆箱：尾包裹余数", () => {
    expect(planPackageTotals(row({ deliverSkcNum: 25, skuQtys: [{ productSkuId: 1, skuNum: 25 }] }), 10)).toEqual([
      10, 10, 5,
    ])
  })

  it("无档案 / 非法装箱数：整单一包", () => {
    expect(planPackageTotals(row(), null)).toEqual([30])
    expect(planPackageTotals(row(), 0)).toEqual([30])
  })

  it("多 SKU 按包内件数求和；无 SKU 明细时按整单件数", () => {
    expect(
      planPackageTotals(
        row({
          skuQtys: [
            { productSkuId: 1, skuNum: 25 },
            { productSkuId: 2, skuNum: 10 },
          ],
        }),
        10,
      ),
    ).toEqual([20, 10, 5])
    expect(planPackageTotals(row({ skuQtys: [] }), 10)).toEqual([10, 10, 10])
  })

  it("超过 10 包返回 null", () => {
    expect(planPackageTotals(row({ deliverSkcNum: 101, skuQtys: [{ productSkuId: 1, skuNum: 101 }] }), 10)).toBeNull()
  })
})

describe("projectStock（扣减后库存累计）", () => {
  // 真实接口形状（getShipInventoryRefAction）：每个入参货号都有一行；
  // 未建档货号同样返回 totalQty=0、shipState=null 的行
  const stock = {
    B049: { totalQty: 100, shipState: "auto" as const, snKey: "B49" },
    B050: { totalQty: 5, shipState: "manual" as const, snKey: "B50" },
  }

  it("同货号按显示顺序累计扣减：before 为前序扣减后的余量", () => {
    const m = projectStock(
      [
        row({ deliveryOrderSn: "A", skcExtCode: "B049", deliverSkcNum: 30 }),
        row({ deliveryOrderSn: "B", skcExtCode: "B049", deliverSkcNum: 40 }),
        row({ deliveryOrderSn: "C", skcExtCode: "B050", deliverSkcNum: 5 }),
      ],
      stock,
    )
    expect(m.get("A")).toEqual({ before: 100, after: 70, short: false })
    expect(m.get("B")).toEqual({ before: 70, after: 30, short: false })
    expect(m.get("C")).toEqual({ before: 5, after: 0, short: false })
  })

  it("扣减后为负 = 库存不足；后续同货号单在已不足的余量上继续累计", () => {
    const m = projectStock(
      [
        row({ deliveryOrderSn: "A", skcExtCode: "B050", deliverSkcNum: 8 }),
        row({ deliveryOrderSn: "B", skcExtCode: "B050", deliverSkcNum: 1 }),
      ],
      stock,
    )
    expect(m.get("A")).toEqual({ before: 5, after: -3, short: true })
    expect(m.get("B")).toEqual({ before: -3, after: -4, short: true })
  })

  it("未建档货号（接口返回 totalQty=0、shipState=null 的行）/ 无货号：不参与库存联动（null）", () => {
    const m = projectStock(
      [
        row({ deliveryOrderSn: "A", skcExtCode: "NOPE", deliverSkcNum: 30 }),
        row({ deliveryOrderSn: "B", skcExtCode: null }),
      ],
      { ...stock, NOPE: { totalQty: 0, shipState: null, snKey: "NOPE" } },
    )
    expect(m.get("A")).toBeNull()
    expect(m.get("B")).toBeNull()
  })

  it("已建档但库存为 0：正常参与联动，扣减后为负（short）", () => {
    const m = projectStock(
      [row({ deliveryOrderSn: "A", skcExtCode: "B060", deliverSkcNum: 3 })],
      { B060: { totalQty: 0, shipState: "auto", snKey: "B60" } },
    )
    expect(m.get("A")).toEqual({ before: 0, after: -3, short: true })
  })

  it("同档案两种货号写法（B049≡B49，snKey 相同）：按归一码合并累计，与服务端口径一致", () => {
    const m = projectStock(
      [
        row({ deliveryOrderSn: "A", skcExtCode: "B049", deliverSkcNum: 60 }),
        row({ deliveryOrderSn: "B", skcExtCode: "B49", deliverSkcNum: 60 }),
      ],
      {
        B049: { totalQty: 100, shipState: "auto", snKey: "B49" },
        B49: { totalQty: 100, shipState: "auto", snKey: "B49" },
      },
    )
    expect(m.get("A")).toEqual({ before: 100, after: 40, short: false })
    expect(m.get("B")).toEqual({ before: 40, after: -20, short: true })
  })
})

describe("chunk（按固定大小切片）", () => {
  it("空数组返回空；尾片不足一整片保留", () => {
    expect(chunk([], 3)).toEqual([])
    expect(chunk([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7],
    ])
  })
})

describe("mapLimit（有界并发）", () => {
  it("空入参直接返回空数组", async () => {
    expect(await mapLimit([], 4, async (n) => n)).toEqual([])
  })

  it("并发峰值不超过 limit；乱序完成仍按下标回位", async () => {
    let running = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 4, async (n) => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, n % 3 === 0 ? 5 : 15))
      running -= 1
      return n * 10
    })
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(0)
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70])
  })

  it("limit<1 兜底为 1：仍串行执行全部项（不静默返回空槽）", async () => {
    const seen: number[] = []
    const out = await mapLimit([1, 2, 3], 0, async (n) => {
      seen.push(n)
      return n * 2
    })
    expect(out).toEqual([2, 4, 6])
    expect(seen).toEqual([1, 2, 3])
  })

  it("单项 reject 整体 rejects", async () => {
    await expect(
      mapLimit([1, 2, 3], 4, async (n) => {
        if (n === 2) throw new Error("boom")
        return n
      }),
    ).rejects.toThrow("boom")
  })
})
