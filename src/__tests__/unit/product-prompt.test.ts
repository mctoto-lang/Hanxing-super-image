import { describe, expect, it } from "vitest"
import {
  buildDirectionPrompt,
  directionInScope,
  fillVars,
  firstSellingPoint,
  formatCardList,
  formatDirectionPool,
  mergeRefineTemplates,
  normalizeSlotCounts,
  parseProductBrief,
} from "@/lib/product/prompt"
import { getPlatformDef } from "@/lib/product/dictionaries"
import {
  DETAIL_DIRECTIONS,
  LEGACY_DETAIL_TEMPLATES,
} from "@/lib/product/detail-directions"
import { DEFAULT_PROMPT_TEMPLATES } from "@/lib/product/prompt-defaults"
import {
  DIRECTION_TEMPLATE_VARS,
  SCENE_TEMPLATE_VARS,
  extractTemplateVars,
} from "@/lib/product/prompt-vars"
import { applySmartMatch } from "@/components/product-v2/direction-picker"

describe("normalizeSlotCounts 智能匹配总量规范化（7~9 保底）", () => {
  const mk = (arr: Array<[string, boolean, number, number]>) =>
    arr.map(([key, selected, count, maxCount]) => ({
      key,
      selected,
      count,
      maxCount,
    }))

  it("总量不足 7 时在已选方向轮转补齐（不超各自上限）", () => {
    const out = normalizeSlotCounts(
      mk([
        ["a", true, 1, 4],
        ["b", true, 2, 3],
        ["c", false, 1, 4],
      ]),
    )
    const total = out
      .filter((s) => s.selected)
      .reduce((sum, s) => sum + s.count, 0)
    expect(total).toBe(7)
    expect(out.find((s) => s.key === "b")?.count).toBe(3) // b 到上限 3 停止
    expect(out.find((s) => s.key === "c")?.selected).toBe(false) // 未选不参与
  })

  it("上限不足以凑满下限时尽力逼近（a=4 + b=2 → 6）", () => {
    const out = normalizeSlotCounts(
      mk([
        ["a", true, 1, 4],
        ["b", true, 2, 2],
      ]),
    )
    const total = out
      .filter((s) => s.selected)
      .reduce((sum, s) => sum + s.count, 0)
    expect(total).toBe(6)
  })

  it("总量超 9 时从张数最多者递减（不低于 1）", () => {
    const out = normalizeSlotCounts(
      mk([
        ["a", true, 4, 4],
        ["b", true, 3, 3],
        ["c", true, 3, 3],
      ]),
    )
    const total = out
      .filter((s) => s.selected)
      .reduce((sum, s) => sum + s.count, 0)
    expect(total).toBe(9)
    expect(out.every((s) => s.count >= 1)).toBe(true)
  })

  it("无法满足下限时尽力逼近（全部到达上限即停）", () => {
    const out = normalizeSlotCounts(mk([["a", true, 1, 2]]))
    expect(out.find((s) => s.key === "a")?.count).toBe(2)
  })

  it("不改入参（返回新数组）", () => {
    const input = mk([["a", true, 1, 4]])
    normalizeSlotCounts(input)
    expect(input[0]!.count).toBe(1)
  })
})

describe("directionInScope 方向作用域判定", () => {
  it("appliesTo 含 scope 时命中", () => {
    expect(directionInScope(["suite", "detail"], "suite")).toBe(true)
    expect(directionInScope(["refine"], "refine")).toBe(true)
  })

  it("appliesTo 不含 scope 时不命中", () => {
    expect(directionInScope(["detail"], "suite")).toBe(false)
    expect(directionInScope(["suite"], "refine")).toBe(false)
  })

  it("null/undefined 一律不命中（两处方向池过滤共用，杜绝池外推荐）", () => {
    expect(directionInScope(null, "suite")).toBe(false)
    expect(directionInScope(undefined, "suite")).toBe(false)
    expect(directionInScope([], "suite")).toBe(false)
  })
})

describe("applySmartMatch 智能匹配结果应用（推荐 ⊆ 方向池回归）", () => {
  const selections = {
    hero_visual: { selected: true, count: 2 },
    usage_scene: { selected: true, count: 1 },
    core_selling: { selected: false, count: 1 },
  }

  it("池外 key 的 AI 槽位不会进入选中态", () => {
    const next = applySmartMatch(selections, [
      { key: "not_in_pool", selected: true, count: 3 },
    ])
    expect(next).not.toHaveProperty("not_in_pool")
    expect(Object.keys(next).sort()).toEqual(
      ["core_selling", "hero_visual", "usage_scene"].sort(),
    )
  })

  it("AI 未命中的池内方向被取消勾选，命中的应用 count 与定制变量", () => {
    const next = applySmartMatch(selections, [
      {
        key: "hero_visual",
        selected: true,
        count: 4,
        angle: "正面平视",
        focus: "产品特写",
      },
    ])
    expect(next.hero_visual).toEqual({
      selected: true,
      count: 4,
      vars: {
        key: "hero_visual",
        selected: true,
        count: 4,
        angle: "正面平视",
        focus: "产品特写",
      },
    })
    expect(next.usage_scene?.selected).toBe(false)
    expect(next.core_selling?.selected).toBe(false)
  })
})

describe("fillVars 模板变量填充", () => {
  it("替换已知变量", () => {
    expect(fillVars("Hero of {{productName}}", { productName: "耳机" })).toBe(
      "Hero of 耳机",
    )
  })

  it("缺失变量替换为空串并压缩空白", () => {
    expect(fillVars("A {{missing}} B", {})).toBe("A B")
  })

  it("压缩连续空格", () => {
    expect(fillVars("X  {{a}}   Y", { a: "mid" })).toBe("X mid Y")
  })

  it("智能匹配变量覆盖基础变量", () => {
    expect(
      fillVars("{{a}}-{{b}}", { a: "base", b: undefined }),
    ).toBe("base-")
    expect(
      fillVars("{{a}}-{{b}}", { a: "base", b: "smart" }),
    ).toBe("base-smart")
  })
})

describe("firstSellingPoint 首个卖点提取", () => {
  it("多行取第一行", () => {
    expect(firstSellingPoint("40dB 降噪\n60 小时续航\n轻量")).toBe("40dB 降噪")
  })

  it("支持中文逗号/顿号/分号分隔", () => {
    expect(firstSellingPoint("降噪、续航；轻量")).toBe("降噪")
  })

  it("空与空白返回空串", () => {
    expect(firstSellingPoint(undefined)).toBe("")
    expect(firstSellingPoint(" \n ")).toBe("")
  })
})

describe("buildDirectionPrompt 方向 prompt 组装", () => {
  const base = {
    mode: "suite" as const,
    platformKey: "amazon",
    languageKey: "en",
    directionKey: "hero_visual",
    promptTemplate: 'Hero shot of {{productName}}. Text: "{{topSellingPoint}}".',
    baseVars: {
      productName: "Wireless Earbuds",
      topSellingPoint: "40dB ANC",
    },
  }

  it("模板不引用规范段变量时输出不含平台/语言段（不再自动追加）", () => {
    const out = buildDirectionPrompt(base)
    expect(out).not.toContain("Follow Amazon")
    expect(out).not.toContain("All text overlay")
    expect(out).toBe('Hero shot of Wireless Earbuds. Text: "40dB ANC".')
  })

  it("模板引用 {{platformSegment}}/{{languageDirective}} 时正确填充", () => {
    const out = buildDirectionPrompt({
      ...base,
      promptTemplate:
        "{{platformSegment}} Hero shot of {{productName}}. {{languageDirective}}",
    })
    expect(out.startsWith("Follow Amazon A+ content visual guidelines")).toBe(true)
    // hero_visual（主图类）platformSegment 拼入 Amazon 主图白底规范
    expect(out).toContain("Amazon main image rules")
    expect(out).toContain("All text overlay in the image must be in English")
    expect(out).toContain("Hero shot of Wireless Earbuds")
  })

  it("非主图类方向 platformSegment 不含平台主图规范", () => {
    const out = buildDirectionPrompt({
      ...base,
      directionKey: "core_selling",
      promptTemplate: "{{platformSegment}} Callout.",
    })
    expect(out).not.toContain("Amazon main image rules")
    expect(out).toContain("Follow Amazon A+ content visual guidelines")
  })

  it("isHero 数据标记使非内置 key 也拼入主图规范", () => {
    const out = buildDirectionPrompt({
      ...base,
      directionKey: "baiditu_2",
      isHero: true,
      promptTemplate: "{{platformSegment}} 白底图。",
    })
    expect(out).toContain("Amazon main image rules")
  })

  it("detail 与 suite 组装一致（无模式差异段）", () => {
    const out = buildDirectionPrompt({ ...base, mode: "detail" })
    expect(out).toBe(buildDirectionPrompt(base))
  })

  it("智能匹配变量参与填充", () => {
    const out = buildDirectionPrompt({
      ...base,
      directionKey: "detail_closeup",
      promptTemplate: "Close-up of {{target}}, {{angle}}.",
      smartVars: { target: "耳罩纹理", angle: "45°" },
    })
    expect(out).toContain("Close-up of 耳罩纹理, 45°.")
  })

  it("补充要求严格模式：模板未引用 {{additionalPrompt}} 即丢弃", () => {
    const out = buildDirectionPrompt({ ...base, additionalPrompt: "no props" })
    expect(out).not.toContain("no props")
  })

  it("补充要求严格模式：模板引用时就地填充", () => {
    const out = buildDirectionPrompt({
      ...base,
      promptTemplate: 'Hero of {{productName}}. {{additionalPrompt}}',
      additionalPrompt: "no props",
    })
    expect(out).toBe("Hero of Wireless Earbuds. no props")
  })

  it("细粒度平台/语言变量可独立引用（hero 原始值不受主图类判定影响）", () => {
    const out = buildDirectionPrompt({
      ...base,
      directionKey: "core_selling", // 非主图类
      promptTemplate:
        "{{platformLabel}} | {{outputLanguage}} | {{platformGeneralSegment}} | {{platformHeroSegment}}",
    })
    expect(out).toContain("亚马逊")
    expect(out).toContain("English")
    expect(out).toContain("Follow Amazon A+ content visual guidelines")
    // 非主图类方向的 {{platformSegment}} 不含主图规范，但 {{platformHeroSegment}} 仍可引用原始值
    expect(out).toContain("Amazon main image rules")
  })

  it("refine 场景：无平台/语言时变量为空，补充要求按引用生效", () => {
    const out = buildDirectionPrompt({
      mode: "refine",
      promptTemplate: "Enhance gloss. {{additionalPrompt}}",
      directionKey: "enhance_gloss",
      baseVars: { productName: "耳机" },
      additionalPrompt: "保持原色",
    })
    expect(out).toBe("Enhance gloss. 保持原色")
  })

  it("未引用变量且平台未配置段时不产生空段", () => {
    const out = buildDirectionPrompt({
      ...base,
      platformKey: "temu",
      promptTemplate: "{{platformSegment}} 白底图 {{languageDirective}}",
    })
    expect(out).toContain("Follow Temu listing style")
    expect(out).not.toContain("undefined")
    expect(out).not.toMatch(/\s{2,}/)
  })
})

describe("DETAIL_DIRECTIONS A+详情页专属方向（V2.4）", () => {
  it("14 个模块方向均为 detail 专属、每方向固定单张", () => {
    expect(DETAIL_DIRECTIONS).toHaveLength(14)
    for (const d of DETAIL_DIRECTIONS) {
      expect(d.appliesTo).toEqual(["detail"])
      expect(d.supportsCount).toBe(false)
      expect(d.maxCount).toBe(1)
    }
  })

  it("模板内嵌规范段/语言指令变量并统一宽幅横向构图", () => {
    for (const d of DETAIL_DIRECTIONS) {
      expect(d.promptTemplate).toContain("{{platformSegment}}")
      expect(d.promptTemplate).toContain("{{languageDirective}}")
      expect(d.promptTemplate).toContain("宽幅")
    }
  })

  it("V2.5 设计感增强：模板含版式/设计元素描述且与上一代快照不同", () => {
    for (const d of DETAIL_DIRECTIONS) {
      expect(d.promptTemplate).not.toBe(LEGACY_DETAIL_TEMPLATES[d.key])
      // 版式与设计语言（分层/分栏/分屏/步骤流/标注/徽章/圆标/文案区等）
      const designHits = [
        "版式",
        "分栏",
        "分屏",
        "宫格",
        "步骤流",
        "标注",
        "徽章",
        "图标",
        "圆标",
        "文案区",
        "分隔线",
        "渐变",
        "投影",
        "数据",
      ].filter((w) => d.promptTemplate.includes(w))
      expect(designHits.length).toBeGreaterThanOrEqual(2)
    }
    // LEGACY 快照仅覆盖首批 8 个（V2.4）；V2.6 新增 6 个无历史行
    const keys = DETAIL_DIRECTIONS.map((d) => d.key)
    expect(Object.keys(LEGACY_DETAIL_TEMPLATES)).toHaveLength(8)
    for (const k of Object.keys(LEGACY_DETAIL_TEMPLATES)) {
      expect(keys).toContain(k)
    }
  })

  it("card_prompt 出卡模板含设计版式要求、白底例外与字数档", () => {
    const t = DEFAULT_PROMPT_TEMPLATES["suite.card_prompt"]!
    expect(t).toContain("250~350")
    expect(t).toContain("版式结构")
    expect(t).toContain("设计元素")
    expect(t).toContain("色彩系统")
    expect(t).toContain("白底主图类方向")
    expect(t).toContain("数据大字")
  })

  it("buildDirectionPrompt 完整变量渲染无残留占位符", () => {
    const d = DETAIL_DIRECTIONS.find((x) => x.key === "detail_hero_banner")!
    const out = buildDirectionPrompt({
      mode: "detail",
      platformKey: "amazon",
      languageKey: "en",
      directionKey: d.key,
      promptTemplate: d.promptTemplate,
      baseVars: {
        productName: "无线降噪耳机",
        sellingPoints: "- 40dB 降噪",
        topSellingPoint: "40dB 降噪",
        targetAudience: "通勤人群",
      },
    })
    expect(out).toContain("Follow Amazon A+ content visual guidelines")
    expect(out).toContain("All text overlay in the image must be in English")
    expect(out).toContain("无线降噪耳机")
    expect(out).toContain("40dB 降噪")
    expect(out).not.toMatch(/\{\{\w+\}\}/)
    expect(out).not.toMatch(/\s{2,}/)
  })

  it("商品变量缺失时句子自然省略、无残留", () => {
    for (const d of DETAIL_DIRECTIONS) {
      const out = buildDirectionPrompt({
        mode: "detail",
        platformKey: "amazon",
        languageKey: "en",
        directionKey: d.key,
        promptTemplate: d.promptTemplate,
        baseVars: {},
      })
      expect(out).not.toMatch(/\{\{\w+\}\}/)
      expect(out).not.toContain("undefined")
      expect(out).not.toMatch(/\s{2,}/)
    }
  })

  it("四平台均配置主图规范段（heroPromptSegment）", () => {
    for (const key of ["amazon", "temu", "shein", "tiktok_shop"]) {
      expect(getPlatformDef(key)?.heroPromptSegment).toBeTruthy()
    }
  })
})

describe("parseProductBrief 商品信息编号文本块解析", () => {
  it("解析完整编号格式（AI 帮写契约）", () => {
    const vars = parseProductBrief(
      [
        "1.商品名称：无线降噪耳机",
        "2.核心卖点：",
        "- 40dB 主动降噪",
        "- 60 小时续航",
        "3.适用人群：通勤办公人群",
        "4.使用场景：地铁通勤与办公室",
        "5.规格参数：",
        "- 蓝牙 5.3",
        "- 重 250g",
        "6.画面建议：金属质感",
      ].join("\n"),
    )
    expect(vars.productName).toBe("无线降噪耳机")
    expect(vars.targetAudience).toBe("通勤办公人群")
    expect(vars.sellingPoints).toContain("40dB 主动降噪")
    // 非映射编号节保留进卖点主体
    expect(vars.sellingPoints).toContain("使用场景：地铁通勤与办公室")
    expect(vars.sellingPoints).toContain("规格参数：蓝牙 5.3；重 250g")
    expect(vars.topSellingPoint).toBe("40dB 主动降噪")
  })

  it("标题与内容同行（1.名称：xxx）", () => {
    const vars = parseProductBrief("1.商品名称：保温杯\n2.核心卖点：\n- 316 不锈钢")
    expect(vars.productName).toBe("保温杯")
    expect(vars.sellingPoints).toBe("316 不锈钢")
  })

  it("无编号结构时整段作为卖点", () => {
    const vars = parseProductBrief("随手写的自由文本卖点")
    expect(vars.sellingPoints).toBe("随手写的自由文本卖点")
    expect(vars.topSellingPoint).toBe("随手写的自由文本卖点")
    expect(vars.productName).toBeUndefined()
  })

  it("空文本返回空对象", () => {
    expect(parseProductBrief("")).toEqual({})
    expect(parseProductBrief(null)).toEqual({})
    expect(parseProductBrief("  \n ")).toEqual({})
  })

  it("只写部分编号节也能解析", () => {
    const vars = parseProductBrief("1.商品名称：台灯\n2.核心卖点：\n- 无频闪护眼")
    expect(vars.productName).toBe("台灯")
    expect(vars.sellingPoints).toBe("无频闪护眼")
    expect(vars.targetAudience).toBeUndefined()
  })

  it("中文顿号编号（1、）同样支持", () => {
    const vars = parseProductBrief("1、商品名称：\n充电宝")
    expect(vars.productName).toBe("充电宝")
  })
})

describe("V2.7 全模板化：fillVars 换行保留", () => {
  it("多行变量（模块池/方向清单）的换行不被空白折叠压扁", () => {
    expect(fillVars("池：\n{{pool}}\n完", { pool: "- a\n- b" })).toBe(
      "池：\n- a\n- b\n完",
    )
  })
})

describe("V2.7 formatDirectionPool / formatCardList 清单变量格式化", () => {
  it("模块池行含 key/名称/描述/上限与主图类标记", () => {
    expect(
      formatDirectionPool([
        {
          key: "hero_visual",
          name: "白底图",
          description: "纯白背景主图",
          maxCount: 4,
          isHero: true,
        },
        { key: "size_chart", name: "尺寸尺码图", description: null, maxCount: 1 },
      ]),
    ).toBe(
      "- hero_visual（白底图：纯白背景主图，maxCount=4，【主图类】）\n- size_chart（尺寸尺码图，maxCount=1）",
    )
  })

  it("出卡清单：编号 + 名称/描述 + 智能匹配定制指导行", () => {
    const out = formatCardList([
      { name: "白底图", description: "纯白背景" },
      {
        name: "卖点图",
        description: null,
        vars: { angle: "45°", copyHint: "轻至 250g" },
      },
    ])
    expect(out.split("\n")[0]).toBe("1. 白底图（纯白背景）")
    expect(out).toContain("2. 卖点图")
    expect(out).toContain("机位=45°")
    expect(out).toContain("图上文案=轻至 250g")
  })

  it("无定制变量的卡片不产生定制指导行", () => {
    expect(formatCardList([{ name: "白底图", description: null }])).toBe(
      "1. 白底图",
    )
  })
})

describe("V2.7 变量注册表与默认模板契约", () => {
  it("extractTemplateVars 提取引用并去重保序", () => {
    expect(extractTemplateVars("{{a}} {{b}} {{a}} 无变量")).toEqual(["a", "b"])
    expect(extractTemplateVars("no vars")).toEqual([])
  })

  it("默认场景模板引用的变量均在场景注册表内", () => {
    for (const [scene, template] of Object.entries(DEFAULT_PROMPT_TEMPLATES)) {
      const known = new Set(
        (SCENE_TEMPLATE_VARS[scene] ?? []).map((v) => v.name),
      )
      const offenders = extractTemplateVars(template).filter(
        (v) => !known.has(v),
      )
      expect(offenders, `${scene} 存在未注册变量`).toEqual([])
    }
  })

  it("A+ 方向模板引用的变量均在方向注册表内", () => {
    const known = new Set(DIRECTION_TEMPLATE_VARS.map((v) => v.name))
    for (const d of DETAIL_DIRECTIONS) {
      const offenders = extractTemplateVars(d.promptTemplate).filter(
        (v) => !known.has(v),
      )
      expect(offenders, `${d.key} 存在未注册变量`).toEqual([])
    }
  })

  it("smart_match / card_prompt / replicate 默认模板含新变量引用", () => {
    expect(DEFAULT_PROMPT_TEMPLATES["suite.smart_match"]).toContain(
      "{{directionPool}}",
    )
    expect(DEFAULT_PROMPT_TEMPLATES["suite.card_prompt"]).toContain("{{cards}}")
    expect(DEFAULT_PROMPT_TEMPLATES["suite.card_prompt"]).toContain(
      "{{cardCount}}",
    )
    for (const key of ["replicate.level_style", "replicate.level_strict"]) {
      const t = DEFAULT_PROMPT_TEMPLATES[key]!
      expect(t).toContain("The LAST reference image") // 参考图语义句并入默认
      expect(t).toContain("{{platformGeneralSegment}}")
      expect(t).toContain("{{languageDirective}}")
      expect(t).toContain("{{additionalPrompt}}")
    }
  })

  it("ai_write 默认模板不引用输出语言（固定简体中文，消除指令冲突）", () => {
    expect(DEFAULT_PROMPT_TEMPLATES["suite.ai_write"]).not.toContain(
      "{{outputLanguage}}",
    )
    expect(DEFAULT_PROMPT_TEMPLATES["detail.ai_write"]).not.toContain(
      "{{outputLanguage}}",
    )
  })

  it("replicate 默认模板全变量渲染无残留占位符", () => {
    const t = DEFAULT_PROMPT_TEMPLATES["replicate.level_style"]!
    const out = fillVars(t, {
      platformGeneralSegment: "Follow Amazon A+ content visual guidelines. ",
      languageDirective: "All text overlay in the image must be in English. ",
      additionalPrompt: "no props",
    })
    expect(out).toContain("Follow Amazon A+ content visual guidelines")
    expect(out).toContain("All text overlay in the image must be in English")
    expect(out.endsWith("no props")).toBe(true)
    expect(out).not.toMatch(/\{\{\w+\}\}/)
    expect(out).not.toMatch(/\s{2,}/)
  })

  it("A+ 方向模板传入补充要求时按引用填充", () => {
    const d = DETAIL_DIRECTIONS.find((x) => x.key === "detail_hero_banner")!
    const out = buildDirectionPrompt({
      mode: "detail",
      platformKey: "amazon",
      languageKey: "en",
      directionKey: d.key,
      promptTemplate: d.promptTemplate,
      baseVars: {},
      additionalPrompt: "加个日出氛围",
    })
    expect(out.endsWith("加个日出氛围")).toBe(true)
    expect(out).not.toMatch(/\{\{\w+\}\}/)
  })
})

describe("mergeRefineTemplates 精修多选合并", () => {
  const t1 = "Enhance gloss. {{additionalPrompt}}"
  const t2 = "Remove scratches. {{additionalPrompt}}"
  const t3 = "Fix perspective."

  it("多模板剥离 {{additionalPrompt}} 后换行拼接，补充要求以单个尾段注入", () => {
    const merged = mergeRefineTemplates([t1, t2], "保留阴影")
    expect(merged).toBe(
      "Enhance gloss.\nRemove scratches.\n{{additionalPrompt}}",
    )
    // fillVars 注入一次即生效
    expect(fillVars(merged, { additionalPrompt: "保留阴影" })).toBe(
      "Enhance gloss.\nRemove scratches.\n保留阴影",
    )
  })

  it("未填补充要求时不注入尾段（严格模式）", () => {
    expect(mergeRefineTemplates([t1, t3], "")).toBe(
      "Enhance gloss.\nFix perspective.",
    )
    expect(mergeRefineTemplates([t1], undefined)).toBe("Enhance gloss.")
  })

  it("单选时等价于原模板去变量 + 可选尾段", () => {
    expect(mergeRefineTemplates([t1], "细节")).toBe(
      "Enhance gloss.\n{{additionalPrompt}}",
    )
  })
})
