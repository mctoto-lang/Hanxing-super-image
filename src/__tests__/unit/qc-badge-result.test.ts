import { describe, expect, it } from "vitest"
import { qcBadgeResult } from "@/components/temu/qc-badge-result"

/**
 * 质检徽章推导回归测试：
 * 官方列表接口不回每行结果值，徽章由「该批数据落地时实际使用的筛选」
 * （loadedFilter）兜底推导。曾按当前选中的 filter 推导，导致「不合格→合格」
 * 切换后、新响应返回前的在途窗口内，旧不合格行短暂显示绿色「合格」徽章。
 * 本函数契约即锁定：入参是 loadedFilter（数据落地时的筛选），不是当前选中值。
 */
describe("qcBadgeResult（质检徽章值推导）", () => {
  it("官方若回行内结果值则优先透传（1-合格 / 2-不合格）", () => {
    expect(qcBadgeResult(1, "2")).toBe(1)
    expect(qcBadgeResult(2, "1")).toBe(2)
  })

  it("行内无值：按数据落地时的筛选推导（loadedFilter=2 → 不合格）", () => {
    expect(qcBadgeResult(null, "2")).toBe(2)
  })

  it("行内无值：按数据落地时的筛选推导（loadedFilter=1 → 合格）", () => {
    expect(qcBadgeResult(null, "1")).toBe(1)
  })

  it("「全部结果」下推行内无值则空占位（null，不按任何筛选错标）", () => {
    expect(qcBadgeResult(null, "all")).toBeNull()
  })
})
