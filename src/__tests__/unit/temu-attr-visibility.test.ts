import { describe, expect, it } from "vitest"
import {
  clearDescendantSelections,
  filterChildValues,
  visibleAttrProps,
  type AttrLinkageProperty,
} from "@/components/temu/publish/attr-visibility"

/**
 * 刊登模板属性父子联动显隐（官方 attrs.get 返回 材质→木材类型→木种 式链；
 * 2026-11-20 案：标准扑克牌组类目「材质」候选不含木材 vid，但 木材类型/木种
 * 以 required:true 返回，一次性全渲染会出现官方后台没有的空下拉并卡死流程）。
 * fixture 取自鸟笼类目实测链：材质 937018(木材 vid 410) → 木材类型 1418354(原木
 * vid 213321) → 木种 1421416(十齿花 vid 213505)。
 */

const sel = (vid: number) => ({ vid, value: `v${vid}` })

const woodChain: AttrLinkageProperty[] = [
  {
    templatePid: 937018,
    parentTemplatePid: 0,
    values: [
      { vid: 410, value: "木材", parentVidList: [] },
      { vid: 900, value: "纸", parentVidList: [] },
      { vid: 901, value: "塑料", parentVidList: [] },
    ],
  },
  {
    templatePid: 1418354,
    parentTemplatePid: 937018,
    values: [
      { vid: 213321, value: "原木", parentVidList: [410] },
      { vid: 213322, value: "再生木", parentVidList: [410] },
    ],
  },
  {
    templatePid: 1421416,
    parentTemplatePid: 1418354,
    values: [
      { vid: 213505, value: "十齿花", parentVidList: [213321] },
      { vid: 213506, value: "无约束值", parentVidList: [] },
    ],
  },
]

describe("filterChildValues", () => {
  it("只留 parentVidList 含父 vid 的值，无约束值恒保留", () => {
    const out = filterChildValues(woodChain[1]!.values, 410)
    expect(out.map((v) => v.vid)).toEqual([213321, 213322])
    // 木种含一条无约束值，任何父 vid 下都保留
    expect(filterChildValues(woodChain[2]!.values, 999999).map((v) => v.vid)).toEqual([213506])
  })

  it("父选值不属于该分支时候选清空（扑克牌案根因）", () => {
    expect(filterChildValues(woodChain[1]!.values, 900)).toEqual([])
  })
})

describe("visibleAttrProps", () => {
  it("根属性恒显示，子属性父未选时隐藏", () => {
    expect(visibleAttrProps(woodChain, {})).toEqual([woodChain[0]])
  })

  it("扑克牌场景：材质选纸（非木材）→ 木材类型/木种整枝隐藏", () => {
    const out = visibleAttrProps(woodChain, { 937018: sel(900) })
    expect(out.map((p) => p.templatePid)).toEqual([937018])
  })

  it("木材分支：材质选木材→木材类型显示；木材类型选原木→木种显示", () => {
    expect(visibleAttrProps(woodChain, { 937018: sel(410) }).map((p) => p.templatePid)).toEqual([
      937018, 1418354,
    ])
    expect(
      visibleAttrProps(woodChain, { 937018: sel(410), 1418354: sel(213321) }).map(
        (p) => p.templatePid,
      ),
    ).toEqual([937018, 1418354, 1421416])
  })

  it("孙级不因祖先残留选中而误显：材质选纸+旧木材类型选中值残留 → 木种仍隐藏", () => {
    const out = visibleAttrProps(woodChain, { 937018: sel(900), 1418354: sel(213321) })
    expect(out.map((p) => p.templatePid)).toEqual([937018])
  })

  it("自由文本型子属性（无候选值集）父已选即显示、父未选隐藏", () => {
    const props: AttrLinkageProperty[] = [
      woodChain[0]!,
      { templatePid: 777, parentTemplatePid: 937018, values: [] },
    ]
    expect(visibleAttrProps(props, { 937018: sel(900) }).map((p) => p.templatePid)).toEqual([
      937018, 777,
    ])
    expect(visibleAttrProps(props, {}).map((p) => p.templatePid)).toEqual([937018])
  })

  it("孤儿子属性（父不在列表）隐藏", () => {
    const props: AttrLinkageProperty[] = [woodChain[0]!, woodChain[2]!]
    expect(visibleAttrProps(props, { 937018: sel(410) })).toEqual([props[0]])
  })
})

describe("clearDescendantSelections", () => {
  it("父属性改选后递归清空子孙选中值（孙级不残留）", () => {
    const out = clearDescendantSelections(937018, woodChain, {
      937018: sel(410),
      1418354: sel(213321),
      1421416: sel(213505),
    })
    expect(out).toEqual({ 937018: sel(410) })
  })

  it("无子孙属性时原样返回（浅拷贝）", () => {
    const before = { 937018: sel(410), 1418354: sel(213321) }
    const out = clearDescendantSelections(1421416, woodChain, before)
    expect(out).toEqual(before)
    expect(out).not.toBe(before)
  })
})
