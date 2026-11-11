/**
 * 组成员弹窗头部描述文案（纯函数，便于单测）：
 * 成员数恒用列表页传入的真实 memberCount（与触发按钮同口径）；
 * 成员列表 action 上限 200 条，列表长度不能当总数，加载完成且
 * 条数少于真实总数（被截断）时提示仅展示条数。
 */
export function groupMembersDescription(
  memberCount: number,
  listCount: number | null,
): string {
  const truncated = listCount !== null && listCount < memberCount
  return `共 ${memberCount} 名成员${truncated ? `；仅展示前 ${listCount} 条` : ""}；整组转移后本组即可删除`
}
