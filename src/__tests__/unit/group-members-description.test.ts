import { describe, expect, it } from "vitest"
import { groupMembersDescription } from "@/components/admin/group-members-description"

/**
 * 组成员弹窗头部口径（回归测试）：
 * 成员列表 action 上限 200 条（listGroupMembersAction .limit(200)），弹窗
 * 头部此前用截断后的列表长度当总数，与表格触发按钮的真实 memberCount
 * 矛盾（按钮 350 / 弹窗 200）。头部须恒用真实总数，截断时提示仅展示条数。
 */

describe("groupMembersDescription（组成员弹窗头部口径）", () => {
  it("加载前（listCount=null）：恒用真实 memberCount", () => {
    expect(groupMembersDescription(350, null)).toBe(
      "共 350 名成员；整组转移后本组即可删除",
    )
  })

  it("未截断（列表=总数）：总数用真实值且无截断提示", () => {
    expect(groupMembersDescription(120, 120)).toBe(
      "共 120 名成员；整组转移后本组即可删除",
    )
  })

  it("超过 200 被截断：总数仍显示真实值并提示仅展示条数", () => {
    expect(groupMembersDescription(350, 200)).toBe(
      "共 350 名成员；仅展示前 200 条；整组转移后本组即可删除",
    )
  })

  it("空组：0 名成员、无截断提示", () => {
    expect(groupMembersDescription(0, 0)).toBe(
      "共 0 名成员；整组转移后本组即可删除",
    )
  })
})
