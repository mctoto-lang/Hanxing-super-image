/**
 * 页面级 tab 条折叠判定（纯函数，供 page-tabs 组件与单测共用）：
 * tab 条 + 右侧工具挤不下一行即折叠为「单 tab + 下拉」，表头保持单行；
 * 没有右侧工具时退化为「tab 条自身放不下才折叠」。
 */

export interface PageTabsMeasure {
  /** 整条 tab 的自然宽度（不受容器约束） */
  barWidth: number
  /** 右侧工具组宽度（无工具传 0） */
  toolsWidth: number
  /** 行 column-gap（tab 条与工具组之间的间距） */
  gap: number
  /** 整行可用宽度 */
  rowWidth: number
}

export function shouldCollapsePageTabs(m: PageTabsMeasure): boolean {
  // 行尚未布局（0 宽）时不折叠：隐藏面板里测不出真实宽度
  if (!(m.rowWidth > 0)) return false
  const need = m.toolsWidth > 0 ? m.barWidth + m.gap + m.toolsWidth : m.barWidth
  // 1px 容差：亚像素舍入避免恰好等宽时误折叠
  return need > m.rowWidth + 1
}
