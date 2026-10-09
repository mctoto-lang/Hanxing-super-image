import { describe, expect, it } from "vitest"

import {
  DEFAULT_ART_RULES,
  DEFAULT_DIRECTION_CONFIGS,
  DEFAULT_REVIEWER_PROMPT,
  DEFAULT_TAROT_TEMPLATE_CONFIG,
  buildTemplateProductionGraph,
  composePromptDesignerPrompt,
  templateProductionMissingSlots,
  type DirectionConfig,
} from "@/lib/agent/pipelines"
import { PIPELINE_NODE_IDS } from "@/lib/agent/pipelines"
import { deriveTeamStatus } from "@/lib/agent/team-status"
import type { TeamEventSnapshot } from "@/lib/agent/team-status"

/**
 * 塔罗模板生产图（评审团全维度节点 + 用户质量覆盖）与团队状态推导单测
 * （纯函数，无 DB）。
 */

function tarotConfig(overrides: Partial<DirectionConfig> = {}): DirectionConfig {
  const base = DEFAULT_DIRECTION_CONFIGS.find((c) => c.direction === "tarot")!
  return {
    ...base,
    models: {
      ...base.models,
      copywriterChatModelId: "00000000-0000-4000-8000-000000000001",
      imageModelId: "00000000-0000-4000-8000-000000000002",
      contentReviewModelId: "00000000-0000-4000-8000-000000000003",
      aestheticReviewModelId: "00000000-0000-4000-8000-000000000004",
      consistencyReviewModelId: "00000000-0000-4000-8000-000000000005",
    },
    ...overrides,
  }
}

function reviewerNodes(graph: ReturnType<typeof buildTemplateProductionGraph>) {
  return graph.nodes.filter((n) => n.id.startsWith("review_"))
}

describe("buildTemplateProductionGraph", () => {
  it("不含 run 级风格/结构节点，保留 item 流水线与打回边", () => {
    const graph = buildTemplateProductionGraph(tarotConfig())
    const ids = graph.nodes.map((n) => n.id)
    expect(ids).not.toContain(PIPELINE_NODE_IDS.style)
    expect(ids).not.toContain(PIPELINE_NODE_IDS.structure)
    for (const id of [
      PIPELINE_NODE_IDS.start,
      PIPELINE_NODE_IDS.copywriter,
      PIPELINE_NODE_IDS.imagegen,
      PIPELINE_NODE_IDS.supervisor,
      PIPELINE_NODE_IDS.end,
    ]) {
      expect(ids).toContain(id)
    }
    // 总控 → 文案打回边（sourceHandle = retry）
    const retryEdge = graph.edges.find(
      (e) => e.source === PIPELINE_NODE_IDS.supervisor && e.sourceHandle === "retry",
    )
    expect(retryEdge?.target).toBe(PIPELINE_NODE_IDS.copywriter)
  })

  it("评审团每个模型一个全维度节点（三维同审、各自阈值），生图/总控均连边", () => {
    const config = tarotConfig({
      templateConfig: {
        ...DEFAULT_TAROT_TEMPLATE_CONFIG,
        reviewerModelIds: [
          "00000000-0000-4000-8000-0000000000aa",
          "00000000-0000-4000-8000-0000000000bb",
        ],
        reviewThresholds: { content: 71, aesthetic: 82, consistency: 69 },
        maxRetries: 3,
      },
    })
    const graph = buildTemplateProductionGraph(config)
    const reviewers = reviewerNodes(graph)
    expect(reviewers).toHaveLength(2)
    for (const node of reviewers) {
      const config2 = node.config as unknown as Record<string, unknown>
      expect(config2.dimensions).toEqual(["content", "aesthetic", "consistency"])
      expect(config2.contentThreshold).toBe(71)
      expect(config2.aestheticThreshold).toBe(82)
      expect(config2.consistencyThreshold).toBe(69)
    }
    expect((reviewers[0]!.config as unknown as Record<string, unknown>).chatModelId).toBe("00000000-0000-4000-8000-0000000000aa")
    expect((reviewers[1]!.config as unknown as Record<string, unknown>).chatModelId).toBe("00000000-0000-4000-8000-0000000000bb")
    // 每个评审节点：生图 → 评审 → 总控两条边
    for (const node of reviewers) {
      expect(graph.edges.some((e) => e.source === PIPELINE_NODE_IDS.imagegen && e.target === node.id)).toBe(true)
      expect(graph.edges.some((e) => e.source === node.id && e.target === PIPELINE_NODE_IDS.supervisor)).toBe(true)
    }
    expect(
      (graph.nodes.find((n) => n.id === PIPELINE_NODE_IDS.supervisor)!.config as unknown as Record<string, unknown>).maxRetries,
    ).toBe(3)
  })

  it("评审团未配置时回退经典三审槽位（去重）；卡面生图优先 templateConfig.cardImageModelId", () => {
    const config = tarotConfig({
      templateConfig: {
        ...DEFAULT_TAROT_TEMPLATE_CONFIG,
        reviewerModelIds: [],
        cardImageModelId: "00000000-0000-4000-8000-0000000000ff",
      },
    })
    const graph = buildTemplateProductionGraph(config)
    const reviewers = reviewerNodes(graph)
    // 经典三审槽位去重后 3 个（互不相同的 uuid）
    expect(reviewers).toHaveLength(3)
    const modelIds = reviewers.map((n) => (n.config as unknown as Record<string, unknown>).chatModelId)
    expect(modelIds).toContain(config.models.contentReviewModelId)
    expect(modelIds).toContain(config.models.aestheticReviewModelId)
    expect(modelIds).toContain(config.models.consistencyReviewModelId)
    expect(
      (graph.nodes.find((n) => n.id === PIPELINE_NODE_IDS.imagegen)!.config as unknown as Record<string, unknown>).imageModelId,
    ).toBe("00000000-0000-4000-8000-0000000000ff")
  })

  it("模板文案模型优先于经典槽位（未设置时回退）", () => {
    const templateCopywriter = "00000000-0000-4000-8000-0000000000cc"
    const withTemplate = tarotConfig({
      templateConfig: {
        ...DEFAULT_TAROT_TEMPLATE_CONFIG,
        reviewerModelIds: ["00000000-0000-4000-8000-0000000000aa"],
        copywriterChatModelId: templateCopywriter,
      },
    })
    const graphT = buildTemplateProductionGraph(withTemplate)
    expect(
      (graphT.nodes.find((n) => n.id === PIPELINE_NODE_IDS.copywriter)!.config as unknown as Record<string, unknown>).chatModelId,
    ).toBe(templateCopywriter)

    const withoutTemplate = tarotConfig({
      templateConfig: {
        ...DEFAULT_TAROT_TEMPLATE_CONFIG,
        reviewerModelIds: ["00000000-0000-4000-8000-0000000000aa"],
        copywriterChatModelId: null,
      },
    })
    const graphF = buildTemplateProductionGraph(withoutTemplate)
    expect(
      (graphF.nodes.find((n) => n.id === PIPELINE_NODE_IDS.copywriter)!.config as unknown as Record<string, unknown>).chatModelId,
    ).toBe(withoutTemplate.models.copywriterChatModelId)
  })

  it("角色提示词与画面规则：未配置走内置默认（含画面规则注入），配置覆盖落到图快照", () => {
    const defaultGraph = buildTemplateProductionGraph(tarotConfig())
    const copywriterDefault = defaultGraph.nodes.find(
      (n) => n.id === PIPELINE_NODE_IDS.copywriter,
    )!.config as unknown as Record<string, unknown>
    // 默认：提示词设计师角色提示词 + 画面规则（design_drafts 与打回重写同源）
    expect(copywriterDefault.rolePrompt).toBe(composePromptDesignerPrompt(null))
    expect(String(copywriterDefault.rolePrompt)).toContain(DEFAULT_ART_RULES)
    const reviewerDefault = reviewerNodes(defaultGraph)[0]!.config as unknown as Record<string, unknown>
    expect(reviewerDefault.reviewPromptOverride).toBe(DEFAULT_REVIEWER_PROMPT)

    const overrideGraph = buildTemplateProductionGraph(
      tarotConfig({
        templateConfig: {
          ...DEFAULT_TAROT_TEMPLATE_CONFIG,
          reviewerModelIds: ["00000000-0000-4000-8000-0000000000aa"],
          rolePrompts: { prompt_designer: "覆盖版提示词设计师", reviewer: "覆盖版评审" },
          artRules: "覆盖版画面规则",
        },
      }),
    )
    const copywriterOverride = overrideGraph.nodes.find(
      (n) => n.id === PIPELINE_NODE_IDS.copywriter,
    )!.config as unknown as Record<string, unknown>
    expect(copywriterOverride.rolePrompt).toBe("覆盖版提示词设计师\n\n覆盖版画面规则")
    const reviewerOverride = reviewerNodes(overrideGraph)[0]!.config as unknown as Record<string, unknown>
    expect(reviewerOverride.reviewPromptOverride).toBe("覆盖版评审")
  })

  it("用户模型覆盖：评审团/提示词撰写/卡面生图均优先于超管配置", () => {
    const config = tarotConfig({
      templateConfig: {
        ...DEFAULT_TAROT_TEMPLATE_CONFIG,
        reviewerModelIds: [
          "00000000-0000-4000-8000-0000000000aa",
          "00000000-0000-4000-8000-0000000000bb",
        ],
        copywriterChatModelId: "00000000-0000-4000-8000-0000000000cc",
        cardImageModelId: "00000000-0000-4000-8000-0000000000ff",
      },
    })
    const graph = buildTemplateProductionGraph(config, undefined, {
      imageModelId: "10000000-0000-4000-8000-000000000001",
      imageSize: "1024x1536",
      copywriterChatModelId: "10000000-0000-4000-8000-000000000002",
      reviewerModelIds: [
        "10000000-0000-4000-8000-000000000003",
        "10000000-0000-4000-8000-000000000004",
        "10000000-0000-4000-8000-000000000005",
      ],
    })
    // 评审团：用户 3 个覆盖超管 2 个
    const reviewers = reviewerNodes(graph)
    expect(reviewers).toHaveLength(3)
    expect(
      reviewers.map((n) => (n.config as unknown as Record<string, unknown>).chatModelId),
    ).toEqual([
      "10000000-0000-4000-8000-000000000003",
      "10000000-0000-4000-8000-000000000004",
      "10000000-0000-4000-8000-000000000005",
    ])
    // 提示词撰写：用户覆盖 → 超管模板 → 经典槽位
    expect(
      (graph.nodes.find((n) => n.id === PIPELINE_NODE_IDS.copywriter)!.config as unknown as Record<string, unknown>).chatModelId,
    ).toBe("10000000-0000-4000-8000-000000000002")
    // 卡面生图：用户覆盖优先
    expect(
      (graph.nodes.find((n) => n.id === PIPELINE_NODE_IDS.imagegen)!.config as unknown as Record<string, unknown>).imageModelId,
    ).toBe("10000000-0000-4000-8000-000000000001")
    expect(
      (graph.nodes.find((n) => n.id === PIPELINE_NODE_IDS.imagegen)!.config as unknown as Record<string, unknown>).imageSize,
    ).toBe("1024x1536")
  })

  it("用户覆盖为空串/空数组时回退超管配置（不误判为已覆盖）", () => {
    const config = tarotConfig({
      templateConfig: {
        ...DEFAULT_TAROT_TEMPLATE_CONFIG,
        reviewerModelIds: ["00000000-0000-4000-8000-0000000000aa"],
        copywriterChatModelId: "00000000-0000-4000-8000-0000000000cc",
      },
    })
    const graph = buildTemplateProductionGraph(config, undefined, {
      imageModelId: null,
      imageSize: null,
      copywriterChatModelId: null,
      reviewerModelIds: [],
    })
    expect(reviewerNodes(graph)).toHaveLength(1)
    expect(
      (reviewerNodes(graph)[0]!.config as unknown as Record<string, unknown>).chatModelId,
    ).toBe("00000000-0000-4000-8000-0000000000aa")
    expect(
      (graph.nodes.find((n) => n.id === PIPELINE_NODE_IDS.copywriter)!.config as unknown as Record<string, unknown>).chatModelId,
    ).toBe("00000000-0000-4000-8000-0000000000cc")
  })

  it("templateProductionMissingSlots：用户覆盖补齐的槽位不算缺失", () => {
    // 超管三槽全缺（模板与经典配置均无），用户覆盖后可开跑
    const emptyConfig = tarotConfig({
      models: {
        ...tarotConfig().models,
        copywriterChatModelId: null,
        imageModelId: null,
        contentReviewModelId: null,
        aestheticReviewModelId: null,
        consistencyReviewModelId: null,
      },
      templateConfig: {
        ...DEFAULT_TAROT_TEMPLATE_CONFIG,
        copywriterChatModelId: null,
        cardImageModelId: null,
        reviewerModelIds: [],
      },
    })
    expect(templateProductionMissingSlots(emptyConfig)).toEqual([
      "提示词撰写模型",
      "卡面生图模型",
      "评审团模型（至少 1 个）",
    ])
    expect(
      templateProductionMissingSlots(emptyConfig, {
        imageModelId: "10000000-0000-4000-8000-000000000001",
        copywriterChatModelId: "10000000-0000-4000-8000-000000000002",
        reviewerModelIds: ["10000000-0000-4000-8000-000000000003"],
      }),
    ).toEqual([])
    // 覆盖为空值时按超管配置判定（不误判为已补齐）
    expect(
      templateProductionMissingSlots(emptyConfig, {
        imageModelId: null,
        copywriterChatModelId: null,
        reviewerModelIds: [],
      }),
    ).toEqual(["提示词撰写模型", "卡面生图模型", "评审团模型（至少 1 个）"])
  })

  it("用户质量覆盖：阈值与打回上限优先于 templateConfig", () => {
    const config = tarotConfig({
      templateConfig: {
        ...DEFAULT_TAROT_TEMPLATE_CONFIG,
        reviewerModelIds: ["00000000-0000-4000-8000-0000000000aa"],
        reviewThresholds: { content: 71, aesthetic: 82, consistency: 69 },
        maxRetries: 2,
      },
    })
    const graph = buildTemplateProductionGraph(config, {
      contentThreshold: 80,
      aestheticThreshold: 90,
      consistencyThreshold: 60,
      maxRetries: 1,
    })
    const reviewer = reviewerNodes(graph)[0]!.config as unknown as Record<string, unknown>
    expect(reviewer.contentThreshold).toBe(80)
    expect(reviewer.aestheticThreshold).toBe(90)
    expect(reviewer.consistencyThreshold).toBe(60)
    expect(
      (graph.nodes.find((n) => n.id === PIPELINE_NODE_IDS.supervisor)!.config as unknown as Record<string, unknown>).maxRetries,
    ).toBe(1)
  })

  it("用户卡面模型覆盖：imagegen 节点优先取用户模型与该模型的同比例预设尺寸", () => {
    const config = tarotConfig({
      templateConfig: {
        ...DEFAULT_TAROT_TEMPLATE_CONFIG,
        reviewerModelIds: ["00000000-0000-4000-8000-0000000000aa"],
        cardImageModelId: "00000000-0000-4000-8000-0000000000ff",
        assetSizes: { card: "1024x1536" },
      },
    })
    const userGraph = buildTemplateProductionGraph(config, undefined, {
      imageModelId: "00000000-0000-4000-8000-0000000000ee",
      imageSize: "896x1344",
    })
    const userNode = userGraph.nodes.find((n) => n.id === PIPELINE_NODE_IDS.imagegen)!.config as unknown as Record<string, unknown>
    expect(userNode.imageModelId).toBe("00000000-0000-4000-8000-0000000000ee")
    expect(userNode.imageSize).toBe("896x1344")

    // 未传覆盖（用户选「平台默认」）时维持 templateConfig → 经典槽位链
    const defaultNode = buildTemplateProductionGraph(config).nodes.find(
      (n) => n.id === PIPELINE_NODE_IDS.imagegen,
    )!.config as unknown as Record<string, unknown>
    expect(defaultNode.imageModelId).toBe("00000000-0000-4000-8000-0000000000ff")
    expect(defaultNode.imageSize).toBe("1024x1536")
  })
})

describe("templateProductionMissingSlots", () => {
  it("配置齐全时无缺失", () => {
    expect(templateProductionMissingSlots(tarotConfig())).toEqual([])
  })

  it("缺生图/终稿细化/评审模型时给出中文提示", () => {
    const base = DEFAULT_DIRECTION_CONFIGS.find((c) => c.direction === "tarot")!
    const missing = templateProductionMissingSlots(base)
    expect(missing).toContain("提示词撰写模型")
    expect(missing).toContain("卡面生图模型")
    expect(missing).toContain("评审团模型（至少 1 个）")
  })
})

describe("deriveTeamStatus · produce_cards", () => {
  const roles = [
    { id: "artist", name: "画师", duty: "生图", group: "production" },
    { id: "creative_director", name: "创意总监", duty: "澄清", group: "planning" },
  ]
  const stages = [
    { id: "clarify", name: "需求澄清", roleIds: ["creative_director"] },
    { id: "art", name: "生图与评审", roleIds: ["artist"] },
  ]

  it("run 执行中 + produce_cards → 画师 working，文案区分小样/全套", () => {
    const result = deriveTeamStatus({
      roles,
      stages,
      run: { stage: "art", status: "running", pendingAction: { kind: "produce_cards", phase: "sample" } },
      events: [] as TeamEventSnapshot[],
      messages: [],
    })
    const artist = result.roles.find((r) => r.roleId === "artist")!
    expect(artist.state).toBe("working")
    expect(artist.currentTask).toContain("小样")

    const fullResult = deriveTeamStatus({
      roles,
      stages,
      run: { stage: "art", status: "running", pendingAction: { kind: "produce_cards", phase: "full" } },
      events: [] as TeamEventSnapshot[],
      messages: [],
    })
    expect(fullResult.roles.find((r) => r.roleId === "artist")!.currentTask).toContain("全套")
  })
})
