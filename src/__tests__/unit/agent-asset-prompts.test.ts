import { describe, expect, it } from "vitest"
import { assetGenerationOrder, assetRuleOfKind, buildTarotAssetPrompt, extractStyleEssence } from "@/lib/agent/asset-prompts"

describe("tarot asset prompts", () => {
  it("uses the six asset order", () => {
    expect(assetGenerationOrder()).toEqual(["border", "back", "box_front", "box_back", "box_side", "box_top"])
  })

  it("每项资产的提示词都是专门内容描述（含主体/构图/纹样要素与负向约束中文转述）", () => {
    for (const kind of assetGenerationOrder()) {
      const prompt = buildTarotAssetPrompt({ kind, styleDoc: null, direction: null })
      expect(prompt.length).toBeGreaterThan(80)
      // 负向约束以中文转述句式注入（不裸拼英文 token，防部分模型反效果）
      expect(prompt).toContain("画面中避免出现：文字、字母、数字、水印、签名")
      expect(prompt).toMatch(/^\d+\. /m) // 硬性规则以编号列表注入
      // 构图措辞占位符全部解析（缺省卡面尺寸 = 方形），无 {orientation} 残留
      expect(prompt).not.toContain("{orientation}")
    }
  })

  it("构图措辞与卡面比例一致：{orientation} 按尺寸填充（竖版/横版/方形）", () => {
    const portrait = buildTarotAssetPrompt({ kind: "box_front", styleDoc: null, direction: null, cardSize: "1024x1536" })
    expect(portrait).toContain("竖版")
    const landscape = buildTarotAssetPrompt({ kind: "box_front", styleDoc: null, direction: null, cardSize: "1536x1024" })
    expect(landscape).toContain("横版")
    const square = buildTarotAssetPrompt({ kind: "box_front", styleDoc: null, direction: null, cardSize: "1024x1024" })
    expect(square).toContain("方形")
    expect(square).not.toContain("竖版")
  })

  it("边框提示词不再携带与生成目标冲突的卡面护栏（no border / no frame）", () => {
    const prompt = buildTarotAssetPrompt({ kind: "border", styleDoc: null, direction: null })
    expect(prompt).not.toContain("卡面负向约束")
    expect(prompt).not.toMatch(/no border|no frame/)
    // 专门描述核心要素：中心干净预留区 + 四边纹样带
    expect(prompt).toContain("预留区")
    expect(prompt).toContain("纹样")
  })

  it("does not put dimensions into prompts", () => {
    const prompt = buildTarotAssetPrompt({ kind: "border", direction: "月相神殿 1024x1536 2:3", styleDoc: null })
    expect(prompt).not.toMatch(/1024x1536|2:3/)
  })

  it("风格只注入提炼要点：不整段搬策划方案，跳过卡面专用节", () => {
    const styleDoc = [
      "【创作简报】",
      "用户想要一套以月相变化为主题的塔罗牌，整体氛围神秘宁静，适合冥想与自我探索场景使用。",
      "【内容方向】月相神殿：以月相轮转与神殿石柱构建静谧的仪式感",
      "【世界观】月光下的白色神殿矗立于海崖之上，月相盘旋成环",
      "【视觉语言】低饱和蓝紫色调、柔和弥散光、细腻石纹质感",
      "【色调】深蓝、银白、淡金",
      "【四花色意象】权杖=月桂枝；圣杯=银杯；宝剑=月牙刃；星币=月石",
      "【大阿卡纳演绎】愚者=踏上神殿台阶的旅人",
    ].join("\n")
    const essence = extractStyleEssence(styleDoc, null)
    expect(essence).toContain("【视觉语言】")
    expect(essence).toContain("【色调】")
    // 卡面专用节与长篇简报不进入风格要点
    expect(essence).not.toContain("四花色")
    expect(essence).not.toContain("大阿卡纳")
    expect(essence).not.toContain("冥想与自我探索")

    const prompt = buildTarotAssetPrompt({ kind: "back", styleDoc, direction: null })
    expect(prompt).toContain("【视觉语言】低饱和蓝紫色调")
    expect(prompt).not.toContain("四花色意象")
  })

  it("风格要点兜底链：styleDoc 缺节 → direction → 固定文案", () => {
    expect(extractStyleEssence(null, "新艺术风格金色线描")).toBe("新艺术风格金色线描")
    expect(extractStyleEssence(null, null)).toBe("与整套塔罗卡面统一的神秘、精致视觉风格")
    // 无节结构的脏 styleDoc：截断后作为要点
    expect(extractStyleEssence("连贯长文本", null)).toBe("连贯长文本")
  })

  it("每项资产都能取到评审用硬性规则（AI 评审打分依据）", () => {
    for (const kind of assetGenerationOrder()) {
      const rule = assetRuleOfKind(kind)
      expect(rule.promptTemplate.length).toBeGreaterThan(10)
      expect(rule.rules.length).toBeGreaterThan(0)
      expect(rule.negativePrompt.length).toBeGreaterThan(0)
    }
  })

  it("未知资产类型抛错（防配置漂移静默）", () => {
    expect(() => assetRuleOfKind("unknown" as never)).toThrow()
  })
})
