import { describe, expect, it } from "vitest"
import {
  aggregateWeightedReview,
  buildFrozenConfig,
  buildOracleCards,
  clampMaxRetries,
  clampThreshold,
  DEFAULT_MAX_RETRIES,
  DEFAULT_REVIEW_THRESHOLD,
  DEFAULT_TEMPLATE_SIZES,
  escapeCsvCell,
  getWorkspaceAgentTemplate,
  listWorkspaceAgentTemplateMetas,
  ORACLE58_CARDS,
  ORACLE_POSITION_ARCHETYPES,
  oracleCardsToCsv,
  POKER58_CARDS,
  promptWritingRulesFor,
  resolveStageStatus,
  resolveStageStatuses,
  resolveCompatibleTemplateSizes,
  SHARED_PROMPT_WRITING_RULES,
  stageOfCardStatus,
  STAGE_CARD_STATUSES,
  stageOrder,
  TAROT81_CARDS,
  templateCardCount,
  templateSizeOf,
  weightedReviewPasses,
  WORKSPACE_AGENT_TEMPLATES,
  workspaceAgentReferenceStyleLines,
  defaultQuality,
  type WorkspaceAgentReviewerVote,
} from "@/lib/workspace/agent-templates"
import {
  WORKSPACE_AGENT_CARD_STATUSES,
  WORKSPACE_AGENT_STAGES,
  WORKSPACE_AGENT_TEMPLATE_KEYS,
  type WorkspaceAgentTemplateKey,
} from "@/lib/workspace/agent-types"

/**
 * 工作台 Agent 模板注册表单测：三产品线骨架结构（81/58/58）、写作规则、
 * 默认阈值与冻结配置、四类尺寸、加权评审聚合、阶段状态映射与神谕 CSV。
 * 全部为纯函数，无 DB / 网络依赖。
 */

function makeVote(overrides: Partial<WorkspaceAgentReviewerVote> = {}): WorkspaceAgentReviewerVote {
  return {
    reviewerId: "rev-1",
    contentPass: true,
    contentScore: 80,
    aestheticScore: 80,
    consistencyScore: 80,
    violations: [],
    reason: "主体明确",
    ...overrides,
  }
}

describe("模板注册表", () => {
  it("三条产品线按词表注册，meta.cardCount 与骨架长度一致", () => {
    expect(WORKSPACE_AGENT_TEMPLATES.map((t) => t.meta.key)).toEqual([...WORKSPACE_AGENT_TEMPLATE_KEYS])
    for (const template of WORKSPACE_AGENT_TEMPLATES) {
      expect(template.cards.length).toBe(template.meta.cardCount)
      expect(template.cards.length).toBeGreaterThan(0)
    }
  })

  it("listWorkspaceAgentTemplateMetas 输出全部元数据", () => {
    const metas = listWorkspaceAgentTemplateMetas()
    expect(metas.map((m) => m.key)).toEqual(["tarot81", "poker58", "oracle58"])
    expect(metas.every((m) => m.kitCount >= 3)).toBe(true)
  })

  it("getWorkspaceAgentTemplate 命中与未注册（null）", () => {
    expect(getWorkspaceAgentTemplate("tarot81")?.meta.name).toContain("塔罗")
    expect(getWorkspaceAgentTemplate("nope" as WorkspaceAgentTemplateKey)).toBeNull()
  })

  it("templateCardCount 返回成品张数（含附加卡）", () => {
    expect(templateCardCount("tarot81")).toBe(81)
    expect(templateCardCount("poker58")).toBe(58)
    expect(templateCardCount("oracle58")).toBe(58)
  })
})

describe("塔罗 81 骨架", () => {
  it("81 张：索引连续、key 唯一、名字非空", () => {
    expect(TAROT81_CARDS).toHaveLength(81)
    expect(TAROT81_CARDS.map((c) => c.index)).toEqual(Array.from({ length: 81 }, (_, i) => i))
    expect(new Set(TAROT81_CARDS.map((c) => c.key)).size).toBe(81)
    expect(TAROT81_CARDS.every((c) => c.name.length > 0 && c.hint.length > 0)).toBe(true)
  })

  it("0-21 大阿卡纳（牌名与 agent 域 tarotSkeleton 同源）", () => {
    const majors = TAROT81_CARDS.filter((c) => c.kind === "major")
    expect(majors).toHaveLength(22)
    expect(TAROT81_CARDS[0]).toMatchObject({ key: "major-00", name: "愚者", arcana: "major" })
    expect(TAROT81_CARDS[21]).toMatchObject({ key: "major-21", name: "世界" })
    expect(majors.every((c) => c.suit === null && c.rank === null)).toBe(true)
  })

  it("22-77 小阿卡纳：四花色各 14（王牌-国王），数字牌 40 + 宫廷牌 16", () => {
    const minors = TAROT81_CARDS.slice(22, 78)
    expect(minors).toHaveLength(56)
    expect(TAROT81_CARDS[22]).toMatchObject({
      key: "minor-wands-01",
      name: "权杖王牌",
      suit: "wands",
      rank: 1,
      kind: "number",
    })
    expect(TAROT81_CARDS[38]).toMatchObject({ name: "圣杯三", suit: "cups", rank: 3 })
    expect(TAROT81_CARDS[35]).toMatchObject({ key: "minor-wands-14", name: "权杖国王", kind: "court" })
    expect(TAROT81_CARDS[49]).toMatchObject({ key: "minor-cups-14", name: "圣杯国王", kind: "court" })
    expect(minors.filter((c) => c.kind === "number")).toHaveLength(40)
    expect(minors.filter((c) => c.kind === "court")).toHaveLength(16)
    // 花色顺序：权杖/圣杯/宝剑/星币，每花色连续 14 张
    expect(minors[0]!.suit).toBe("wands")
    expect(minors[13]!.suit).toBe("wands")
    expect(minors[14]!.suit).toBe("cups")
    expect(minors[55]!.suit).toBe("pentacles")
  })

  it("78-80 套件交付物：牌背 / 边框 / 牌盒（3/4 视图）", () => {
    const kit = TAROT81_CARDS.slice(78)
    expect(kit.map((c) => c.key)).toEqual(["kit-back", "kit-border", "kit-box"])
    expect(kit.map((c) => c.kind)).toEqual(["back", "border", "box"])
    expect(kit.every((c) => c.arcana === null && c.suit === null && c.rank === null)).toBe(true)
    expect(kit[2]!.hint).toContain("3/4 视图")
  })
})

describe("扑克 58 骨架", () => {
  it("58 张：索引连续、key 唯一", () => {
    expect(POKER58_CARDS).toHaveLength(58)
    expect(POKER58_CARDS.map((c) => c.index)).toEqual(Array.from({ length: 58 }, (_, i) => i))
    expect(new Set(POKER58_CARDS.map((c) => c.key)).size).toBe(58)
  })

  it("0-51 花色牌：四花色各 13，A=1 … 10 按面值，J/Q/K 为人物牌", () => {
    const suitCards = POKER58_CARDS.slice(0, 52)
    expect(POKER58_CARDS[0]).toMatchObject({
      key: "poker-spades-A",
      name: "黑桃A",
      suit: "spades",
      pipCount: 1,
      kind: "number",
    })
    expect(POKER58_CARDS[9]).toMatchObject({ name: "黑桃10", pipCount: 10 })
    expect(POKER58_CARDS[10]).toMatchObject({ name: "黑桃J", pipCount: null, kind: "court" })
    expect(POKER58_CARDS[12]).toMatchObject({ name: "黑桃K", pipCount: null })
    expect(POKER58_CARDS[13]).toMatchObject({ name: "红心A", suit: "hearts" })
    expect(POKER58_CARDS[51]).toMatchObject({ name: "梅花K", suit: "clubs" })
    expect(suitCards.filter((c) => c.kind === "number")).toHaveLength(40)
    expect(suitCards.filter((c) => c.kind === "court")).toHaveLength(12)
  })

  it("52-53 大小王、54 替换牌面 + 55-57 套件交付物（牌背/边框/牌盒）", () => {
    expect(POKER58_CARDS[52]).toMatchObject({ key: "joker-big", name: "大王", joker: "big", kind: "joker" })
    expect(POKER58_CARDS[53]).toMatchObject({ key: "joker-small", name: "小王", joker: "small" })
    expect(POKER58_CARDS[54]).toMatchObject({
      key: "kit-replacement",
      name: "替换牌面",
      kind: "replacement",
    })
    expect(POKER58_CARDS.slice(55).map((c) => c.key)).toEqual([
      "kit-back",
      "kit-border",
      "kit-box",
    ])
    expect(POKER58_CARDS.slice(55).map((c) => c.kind)).toEqual(["back", "border", "box"])
  })
})

describe("神谕 58 骨架", () => {
  it("58 张 = 5 组 × 11 位置牌 + 3 套件交付物；索引连续、key 唯一", () => {
    expect(ORACLE58_CARDS).toHaveLength(58)
    expect(ORACLE58_CARDS.filter((c) => c.kind === "position")).toHaveLength(55)
    expect(ORACLE58_CARDS.slice(55).map((c) => c.kind)).toEqual(["back", "border", "box"])
    expect(ORACLE58_CARDS.map((c) => c.index)).toEqual(Array.from({ length: 58 }, (_, i) => i))
    expect(new Set(ORACLE58_CARDS.map((c) => c.key)).size).toBe(58)
  })

  it("每组 11 个位置，位置原型序列一致（启程…回归），key/name 确定性生成", () => {
    expect(ORACLE_POSITION_ARCHETYPES).toHaveLength(11)
    for (let g = 1; g <= 5; g++) {
      const group = ORACLE58_CARDS.filter((c) => c.groupIndex === g)
      expect(group).toHaveLength(11)
      expect(group.map((c) => c.positionName)).toEqual(ORACLE_POSITION_ARCHETYPES.map((a) => a.name))
      expect(group[0]!.key).toBe(`oracle-g${g}-p01`)
      expect(group[10]!.key).toBe(`oracle-g${g}-p11`)
      expect(group.every((c) => c.groupName === `组${"一二三四五"[g - 1]}`)).toBe(true)
    }
    expect(ORACLE58_CARDS[0]).toMatchObject({ name: "组一 · 启程", kind: "position" })
    expect(ORACLE58_CARDS[54]).toMatchObject({ key: "oracle-g5-p11", name: "组五 · 回归" })
  })

  it("buildOracleCards 支持按主题重命名组名，空白名回退默认序数", () => {
    const cards = buildOracleCards(["月相", "潮汐", "", "  ", "星尘"])
    expect(cards[0]).toMatchObject({ name: "月相 · 启程", groupName: "月相", key: "oracle-g1-p01" })
    expect(cards[11]).toMatchObject({ groupName: "潮汐" })
    expect(cards[22]).toMatchObject({ groupName: "组三" })
    expect(cards[33]).toMatchObject({ groupName: "组四" })
    expect(cards[44]).toMatchObject({ groupName: "星尘" })
    expect(cards).toHaveLength(58)
  })

  it("buildOracleCards 组名数量不是 5 个时抛错", () => {
    expect(() => buildOracleCards(["a", "b", "c", "d"])).toThrow()
    expect(() => buildOracleCards(["a", "b", "c", "d", "e", "f"])).toThrow()
  })
})

describe("模板提示词写作规则", () => {
  it("共享规则 + 模板专属规则；专属规则逐模板不同", () => {
    for (const key of WORKSPACE_AGENT_TEMPLATE_KEYS) {
      const rules = promptWritingRulesFor(key)
      expect(rules.slice(0, SHARED_PROMPT_WRITING_RULES.length)).toEqual([...SHARED_PROMPT_WRITING_RULES])
      expect(rules.length).toBeGreaterThan(SHARED_PROMPT_WRITING_RULES.length)
    }
    expect(promptWritingRulesFor("tarot81").join("\n")).toContain("花色数量硬规则")
    expect(promptWritingRulesFor("poker58").join("\n")).toContain("点数数量硬规则")
    expect(promptWritingRulesFor("oracle58").join("\n")).toContain("位置语义规则")
  })

  it("共享规则保留风格分离与无边框硬规则口径", () => {
    const all = SHARED_PROMPT_WRITING_RULES.join("\n")
    expect(all).toContain("风格分离")
    expect(all).toContain("无边框硬规则")
    expect(all).toContain("120-200 字")
  })
})

describe("默认阈值与冻结配置", () => {
  it("默认阈值 75 / 打回 2（三维度统一）", () => {
    expect(DEFAULT_REVIEW_THRESHOLD).toBe(75)
    expect(DEFAULT_MAX_RETRIES).toBe(2)
    expect(defaultQuality()).toEqual({
      contentThreshold: 75,
      aestheticThreshold: 75,
      consistencyThreshold: 75,
      maxRetries: 2,
    })
  })

  it("钳制：阈值 [40,95]，打回 [0,3]", () => {
    expect(clampThreshold(39)).toBe(40)
    expect(clampThreshold(96)).toBe(95)
    expect(clampThreshold(74.6)).toBe(75)
    expect(clampMaxRetries(-1)).toBe(0)
    expect(clampMaxRetries(4)).toBe(3)
    expect(clampMaxRetries(2.4)).toBe(2)
  })

  it("buildFrozenConfig 默认值来自模板（cardCount/quality/sizes）且 frozenAt 透传", () => {
    const frozen = buildFrozenConfig({ templateKey: "tarot81", frozenAt: "2026-10-12T00:00:00.000Z" })
    expect(frozen).toEqual({
      templateKey: "tarot81",
      cardCount: 81,
      quality: { contentThreshold: 75, aestheticThreshold: 75, consistencyThreshold: 75, maxRetries: 2 },
      sizes: DEFAULT_TEMPLATE_SIZES.tarot81,
      frozenAt: "2026-10-12T00:00:00.000Z",
    })
    expect(buildFrozenConfig({ templateKey: "oracle58", frozenAt: "t" }).cardCount).toBe(58)
  })

  it("buildFrozenConfig 覆盖项就地钳制，sizes 只覆盖传入的类别", () => {
    const frozen = buildFrozenConfig({
      templateKey: "poker58",
      quality: { contentThreshold: 200, maxRetries: 9 },
      sizes: { card: "832x1216" },
      frozenAt: "t",
    })
    expect(frozen.quality.contentThreshold).toBe(95)
    expect(frozen.quality.maxRetries).toBe(3)
    expect(frozen.quality.aestheticThreshold).toBe(75)
    expect(frozen.sizes.card).toBe("832x1216")
    expect(frozen.sizes.box).toBe(DEFAULT_TEMPLATE_SIZES.poker58.box)
  })
})

describe("四类尺寸映射", () => {
  it("塔罗/神谕卡面 2:3，扑克卡面 3:4；边框与卡面同比例，牌盒为横版", () => {
    expect(templateSizeOf("tarot81", "card")).toBe("1024x1536")
    expect(templateSizeOf("tarot81", "border")).toBe(templateSizeOf("tarot81", "card"))
    expect(templateSizeOf("tarot81", "box")).toBe("1536x1024")
    expect(templateSizeOf("poker58", "card")).toBe("768x1024")
    expect(templateSizeOf("poker58", "box")).toBe("1024x768")
    expect(templateSizeOf("oracle58", "card")).toBe("1024x1536")
  })

  it("四类尺寸在每个模板下齐全（card/back/border/box）", () => {
    for (const key of WORKSPACE_AGENT_TEMPLATE_KEYS) {
      for (const kind of ["card", "back", "border", "box"] as const) {
        expect(templateSizeOf(key, kind)).toMatch(/^\d+x\d+$/)
      }
    }
  })
})

describe("评审加权聚合", () => {
  it("空投票与非正权重抛错", () => {
    expect(() => aggregateWeightedReview([])).toThrow()
    expect(() => aggregateWeightedReview([makeVote({ weight: 0 })])).toThrow()
    expect(() => aggregateWeightedReview([makeVote({ weight: -1 })])).toThrow()
    expect(() => aggregateWeightedReview([makeVote({ weight: Number.NaN })])).toThrow()
  })

  it("单评审员一票否决", () => {
    expect(aggregateWeightedReview([makeVote()]).contentPass).toBe(true)
    expect(aggregateWeightedReview([makeVote({ contentPass: false })]).contentPass).toBe(false)
  })

  it("等权多数票：2/3 通过为通过，2/3 不通过为不通过", () => {
    const twoOfThree = aggregateWeightedReview([
      makeVote({ reviewerId: "a", contentPass: true }),
      makeVote({ reviewerId: "b", contentPass: false }),
      makeVote({ reviewerId: "c", contentPass: false }),
    ])
    expect(twoOfThree.contentPass).toBe(false)
    expect(twoOfThree.reviewerCount).toBe(3)
    expect(twoOfThree.totalWeight).toBe(3)
    expect(twoOfThree.passedWeight).toBe(1)
  })

  it("权重可以翻转多数票：3:1 权重下 1 票通过即过、1 票不通过即不过", () => {
    expect(
      aggregateWeightedReview([
        makeVote({ reviewerId: "main", weight: 3, contentPass: true }),
        makeVote({ reviewerId: "aux", weight: 1, contentPass: false }),
      ]).contentPass,
    ).toBe(true)
    expect(
      aggregateWeightedReview([
        makeVote({ reviewerId: "main", weight: 3, contentPass: false }),
        makeVote({ reviewerId: "aux", weight: 1, contentPass: true }),
      ]).contentPass,
    ).toBe(false)
  })

  it("三维分数为加权平均并四舍五入收敛 0-100", () => {
    const weighted = aggregateWeightedReview([
      makeVote({ reviewerId: "main", weight: 3, aestheticScore: 70, consistencyScore: 110 }),
      makeVote({ reviewerId: "aux", weight: 1, aestheticScore: 90, consistencyScore: 110 }),
    ])
    expect(weighted.aestheticScore).toBe(75) // (70×3 + 90×1) / 4
    expect(weighted.consistencyScore).toBe(100) // 加权平均 110 → 钳制上限
    const rounded = aggregateWeightedReview([
      makeVote({ reviewerId: "a", aestheticScore: 80 }),
      makeVote({ reviewerId: "b", aestheticScore: 81 }),
    ])
    expect(rounded.aestheticScore).toBe(81) // 80.5 → 81
  })

  it("违规项按权重多数票收录；单评审员任一违规收录", () => {
    const majority = aggregateWeightedReview([
      makeVote({ reviewerId: "a", violations: ["text"] }),
      makeVote({ reviewerId: "b", violations: ["text"] }),
      makeVote({ reviewerId: "c", violations: [] }),
    ])
    expect(majority.violations).toEqual(["text"])
    const weightedNotEnough = aggregateWeightedReview([
      makeVote({ reviewerId: "main", weight: 2, violations: ["border"] }),
      makeVote({ reviewerId: "aux", weight: 2, violations: [] }),
    ])
    expect(weightedNotEnough.violations).toEqual([]) // 2/4 不过半
    const weightedEnough = aggregateWeightedReview([
      makeVote({ reviewerId: "main", weight: 3, violations: ["border"] }),
      makeVote({ reviewerId: "aux", weight: 1, violations: [] }),
    ])
    expect(weightedEnough.violations).toEqual(["border"])
    expect(aggregateWeightedReview([makeVote({ violations: ["watermark"] })]).violations).toEqual([
      "watermark",
    ])
  })

  it("reasons 去空保序", () => {
    const result = aggregateWeightedReview([
      makeVote({ reviewerId: "a", reason: undefined }),
      makeVote({ reviewerId: "b", reason: "构图失衡" }),
    ])
    expect(result.reasons).toEqual(["构图失衡"])
  })

  it("weightedReviewPasses：内容通过 + 无违规 + 三维达线才放行", () => {
    const thresholds = { contentThreshold: 75, aestheticThreshold: 75, consistencyThreshold: 75 }
    const pass = aggregateWeightedReview([makeVote()])
    expect(weightedReviewPasses(pass, thresholds)).toBe(true)
    expect(
      weightedReviewPasses(
        aggregateWeightedReview([makeVote({ aestheticScore: 74 })]),
        thresholds,
      ),
    ).toBe(false)
    expect(
      weightedReviewPasses(
        aggregateWeightedReview([makeVote({ violations: ["text"] })]),
        thresholds,
      ),
    ).toBe(false)
    expect(
      weightedReviewPasses(aggregateWeightedReview([makeVote({ contentPass: false })]), thresholds),
    ).toBe(false)
  })
})

describe("阶段状态映射", () => {
  it("STAGE_CARD_STATUSES 是单卡状态词表的完整划分（无重叠、clarify 为空）", () => {
    expect(STAGE_CARD_STATUSES.clarify).toEqual([])
    const all = Object.values(STAGE_CARD_STATUSES).flat()
    expect(all.length).toBe(WORKSPACE_AGENT_CARD_STATUSES.length)
    expect(new Set(all).size).toBe(WORKSPACE_AGENT_CARD_STATUSES.length)
    for (const status of WORKSPACE_AGENT_CARD_STATUSES) {
      expect(all).toContain(status)
    }
  })

  it("stageOfCardStatus 按阶段归集", () => {
    expect(stageOfCardStatus("pending")).toBe("draft")
    expect(stageOfCardStatus("drafting")).toBe("draft")
    expect(stageOfCardStatus("generating")).toBe("art")
    expect(stageOfCardStatus("approved_by_ai")).toBe("art")
    expect(stageOfCardStatus("fallback")).toBe("art")
    expect(stageOfCardStatus("failed")).toBe("art")
    expect(stageOfCardStatus("waiting_human")).toBe("compose")
    expect(stageOfCardStatus("confirmed")).toBe("compose")
    expect(stageOfCardStatus("cancelled")).toBe("compose")
  })

  it("stageOrder 与阶段词表同序递增", () => {
    expect(WORKSPACE_AGENT_STAGES).toEqual(["clarify", "draft", "art", "compose"] as const)
    expect(stageOrder("clarify")).toBeLessThan(stageOrder("draft"))
    expect(stageOrder("draft")).toBeLessThan(stageOrder("art"))
    expect(stageOrder("art")).toBeLessThan(stageOrder("compose"))
  })

  it("resolveStageStatus：过去 done / 未来 locked / 当前视进度", () => {
    expect(resolveStageStatus("clarify", "draft")).toBe("done")
    expect(resolveStageStatus("compose", "draft")).toBe("locked")
    expect(resolveStageStatus("draft", "draft")).toBe("active")
    expect(
      resolveStageStatus("draft", "draft", { total: 58, completed: 50, failed: 8, inFlight: 0 }),
    ).toBe("done")
    // 有在途卡时不判完成
    expect(
      resolveStageStatus("draft", "draft", { total: 58, completed: 58, failed: 0, inFlight: 1 }),
    ).toBe("active")
    // 无逐卡单元的阶段（clarify）当前时恒 active
    expect(resolveStageStatus("clarify", "clarify")).toBe("active")
  })

  it("resolveStageStatuses 一次算齐四阶段", () => {
    expect(resolveStageStatuses("draft")).toEqual({
      clarify: "done",
      draft: "active",
      art: "locked",
      compose: "locked",
    })
    expect(
      resolveStageStatuses("art", {
        draft: { total: 81, completed: 81, failed: 0, inFlight: 0 },
      }),
    ).toEqual({
      clarify: "done",
      draft: "done",
      art: "active",
      compose: "locked",
    })
  })
})

describe("神谕 CSV", () => {
  it("escapeCsvCell：普通值原样，逗号/引号/换行触发引号包裹与引号翻倍", () => {
    expect(escapeCsvCell("组一")).toBe("组一")
    expect(escapeCsvCell("雾,与星")).toBe('"雾,与星"')
    expect(escapeCsvCell('说"你好"')).toBe('"说""你好"""')
    expect(escapeCsvCell("第一行\n第二行")).toBe('"第一行\n第二行"')
    expect(escapeCsvCell("a,b\nc\"d")).toBe('"a,b\nc""d"')
  })

  it("oracleCardsToCsv：首行列头 + 58 行数据（默认骨架）", () => {
    const csv = oracleCardsToCsv()
    const lines = csv.split("\n")
    expect(lines).toHaveLength(59)
    expect(lines[0]).toBe("序号,卡片Key,组,位置,卡名,类型,骨架提示")
    expect(lines[1]).toBe("0,oracle-g1-p01,组一,1,组一 · 启程,位置牌,开端与新芽：旅程起点，萌发与期待（组主题：组一）")
    const last = lines[58]!
    expect(last).toContain("kit-box")
    expect(last).toContain("牌盒")
  })

  it("套件交付物行的组/位置占位为 -；无转义行字段数为 7", () => {
    const csv = oracleCardsToCsv()
    const kitLine = csv.split("\n").find((line) => line.includes("kit-back"))!
    expect(kitLine.split(",")[2]).toBe("-")
    expect(kitLine.split(",")[3]).toBe("-")
    expect(kitLine).toContain("牌背")
    for (const line of csv.split("\n")) {
      if (!line.includes('"')) {
        expect(line.split(",")).toHaveLength(7)
      }
    }
  })

  it("重命名组名导出：含逗号的组名被正确转义", () => {
    const csv = oracleCardsToCsv(buildOracleCards(["雾,与星", "潮汐", "星尘", "大地", "风暴"]))
    const firstDataLine = csv.split("\n")[1]!
    expect(firstDataLine).toContain('"雾,与星 · 启程"')
    expect(firstDataLine).toContain('"雾,与星"')
    expect(firstDataLine).toContain("oracle-g1-p01")
  })
})

describe("resolveCompatibleTemplateSizes（切换生图模型时的尺寸适配）", () => {
  const tarot = DEFAULT_TEMPLATE_SIZES.tarot81

  it("仍受支持的尺寸原样保留；不受支持的类别回退模板默认，再回退首个可用预设", () => {
    const sizes = resolveCompatibleTemplateSizes({
      templateKey: "tarot81",
      current: tarot,
      enabledSizes: ["1024x768", "1024x1536"],
    })
    // card/back/border（1024x1536 在预设内）保留；box（1536x1024）不在预设且
    // 模板默认 box 同样不可用 → 回退首个可用 1024x768
    expect(sizes).toEqual({ card: "1024x1536", back: "1024x1536", border: "1024x1536", box: "1024x768" })
  })

  it("模板默认也不可用时全部类别回退到首个可用预设", () => {
    const sizes = resolveCompatibleTemplateSizes({
      templateKey: "tarot81",
      current: tarot,
      enabledSizes: ["832x1216"],
    })
    expect(sizes).toEqual({ card: "832x1216", back: "832x1216", border: "832x1216", box: "832x1216" })
  })

  it("可用预设为空返回 null（调用方保持原状不误改）", () => {
    expect(
      resolveCompatibleTemplateSizes({ templateKey: "tarot81", current: tarot, enabledSizes: [] }),
    ).toBeNull()
  })

  it("重复预设值不影响结果", () => {
    const sizes = resolveCompatibleTemplateSizes({
      templateKey: "tarot81",
      current: tarot,
      enabledSizes: ["1024x1536", "1024x1536", "1536x1024"],
    })
    expect(sizes).toEqual(tarot)
  })
})

describe("workspaceAgentReferenceStyleLines（风格输入拼装）", () => {
  it("用户描述与 AI 分析并存时两行都输出，分析在前", () => {
    const lines = workspaceAgentReferenceStyleLines({
      stylePrompt: " 水彩手绘 ",
      referenceStyleAnalysis: "低饱和蓝灰水彩",
    })
    expect(lines).toEqual(["【参考图 AI 风格分析】低饱和蓝灰水彩", "【用户风格描述】水彩手绘"])
  })

  it("确认后 stylePrompt 与分析相同（分析结果被回填确认）时不重复输出", () => {
    const lines = workspaceAgentReferenceStyleLines({
      stylePrompt: "低饱和蓝灰水彩",
      referenceStyleAnalysis: "低饱和蓝灰水彩",
    })
    expect(lines).toEqual(["【用户风格描述】低饱和蓝灰水彩"])
  })

  it("只有分析时仅输出分析行；两者皆空时输出空数组", () => {
    expect(workspaceAgentReferenceStyleLines({ referenceStyleAnalysis: "哑光厚涂" })).toEqual([
      "【参考图 AI 风格分析】哑光厚涂",
    ])
    expect(workspaceAgentReferenceStyleLines({})).toEqual([])
  })
})
