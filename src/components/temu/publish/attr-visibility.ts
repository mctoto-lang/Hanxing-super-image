/**
 * 属性模板父子联动纯函数（bg.glo.goods.attrs.get 的 材质→木材类型→木种 式链）。
 * 官方卖家后台对子属性是动态显隐：父属性选中触发值（如 材质=木材）才浮现子属性，
 * 父选值不属于该分支则整枝隐藏。此处与向导/单测共用，无 React/server 依赖。
 */

export interface AttrLinkageValue {
  vid: number
  value: string
  /** 合法父 vid 集（空=无约束，恒可选） */
  parentVidList: number[]
}

export interface AttrLinkageProperty {
  templatePid: number
  /** 父属性 templatePid（0=根属性） */
  parentTemplatePid: number
  values: AttrLinkageValue[]
}

export interface AttrSelection {
  vid: number
  value: string
}

/** 子属性候选值按父选中 vid 过滤：无约束值恒保留，其余须含父 vid */
export function filterChildValues<T extends AttrLinkageValue>(values: T[], parentVid: number): T[] {
  return values.filter((v) => v.parentVidList.length === 0 || v.parentVidList.includes(parentVid))
}

/**
 * 计算当前应显示的属性（官方后台同款动态显隐）：
 * - 根属性（无 parentTemplatePid）恒显示
 * - 子属性须整条祖先链可见且父属性已选中；有候选值集时还须过滤后非空
 *   （父选值不属于该分支则隐藏，如 材质=纸 时隐藏 木材类型/木种）
 * - 自由文本型子属性（无候选值集）父已选即显示
 * - 父属性不在列表内（如被 required/isSale 过滤）的孤儿子属性无法满足，隐藏
 * - parentTemplatePid 环形/自引用脏数据：祖先链视为不可达，隐藏（防无限递归）
 */
export function visibleAttrProps<P extends AttrLinkageProperty>(
  props: P[],
  selected: Record<number, AttrSelection>,
): P[] {
  const visible = new Set<number>()
  const isVisible = (p: P, seen: Set<number>): boolean => {
    if (!p.parentTemplatePid) return true
    if (visible.has(p.templatePid)) return true
    // 本条祖先链上再入 = 环形/自引用脏数据，断链视为不可见
    if (seen.has(p.templatePid)) return false
    seen.add(p.templatePid)
    const parent = props.find((x) => x.templatePid === p.parentTemplatePid)
    if (!parent || !isVisible(parent, seen)) return false
    const parentSel = selected[p.parentTemplatePid]
    if (!parentSel) return false
    return p.values.length === 0 || filterChildValues(p.values, parentSel.vid).length > 0
  }
  return props.filter((p) => {
    const ok = isVisible(p, new Set())
    if (ok) visible.add(p.templatePid)
    return ok
  })
}

/**
 * 父属性改选后递归清除全部子孙属性的选中值（旧值对新父 vid 可能非法，
 * 下拉只过滤 options 不清 state；不递归会残留孙级旧值）。
 */
export function clearDescendantSelections(
  changedPid: number,
  props: { templatePid: number; parentTemplatePid: number }[],
  selected: Record<number, AttrSelection>,
): Record<number, AttrSelection> {
  const next = { ...selected }
  // parentTemplatePid 环形/自引用脏数据兜底：已清过的节点不再入递归（防无限递归）
  const cleared = new Set<number>()
  const clear = (pid: number) => {
    for (const child of props) {
      if (child.parentTemplatePid === pid && !cleared.has(child.templatePid)) {
        cleared.add(child.templatePid)
        delete next[child.templatePid]
        clear(child.templatePid)
      }
    }
  }
  clear(changedPid)
  return next
}
