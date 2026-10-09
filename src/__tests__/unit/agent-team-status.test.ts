import { describe, expect, it } from "vitest"

import { deriveTeamStatus } from "@/lib/agent/team-status"
import type {
  TeamEventSnapshot,
  TeamItemSnapshot,
  TeamMessageSnapshot,
  TeamStatus,
} from "@/lib/agent/team-status"

/**
 * 团队状态推导单测（纯函数，无 DB / 无组件运行时）。
 *
 * 语义要点：
 * - pendingAction 归属角色 + run 排队/执行中 → working（进行中文案按动作分派）；
 * - run waiting_human + 当前阶段角色已产出待确认内容 → waiting_user；
 * - 角色最新事件 fail（未被后续 done 接管）→ error；
 * - 角色所属阶段已推进到当前阶段之前 → done；
 * - 未来阶段角色 → idle（“待命，将在「X」阶段加入”）；
 * - usedCount = 编制总数，participatedCount = 有事件/消息的角色数。
 */

const ROLES = [
  { id: "creative_director", name: "创意总监", duty: "主持需求澄清（只问风格/内容/主题）", group: "planning" },
  { id: "style_director", name: "风格策划", duty: "拟定唯一《风格规范书》", group: "planning" },
  { id: "prompt_designer", name: "提示词设计师", duty: "逐张撰写单段短提示词", group: "planning" },
  { id: "final_refiner", name: "终稿细化师", duty: "初稿细化为结构化终稿", group: "planning" },
  { id: "artist", name: "画师", duty: "按终稿与参考图逐张生图", group: "production" },
  { id: "review_panel", name: "评审团", duty: "内容/审美/一致性三审打回", group: "qa" },
  { id: "compositor", name: "合成师", duty: "边框叠加与牌名编号排版", group: "delivery" },
  { id: "supervisor", name: "总控", duty: "三审裁决：放行/打回/兜底", group: "control" },
] as const

const STAGES = [
  { id: "clarify", name: "需求澄清", roleIds: ["creative_director"] },
  { id: "draft", name: "初稿设计", roleIds: ["style_director", "prompt_designer"] },
  { id: "final", name: "终稿细化", roleIds: ["final_refiner"] },
  { id: "art", name: "生图与评审", roleIds: ["final_refiner", "artist", "review_panel", "supervisor"] },
  { id: "compose", name: "融合与交付", roleIds: ["compositor", "supervisor"] },
] as const

function event(overrides: Partial<TeamEventSnapshot> & { nodeKey: string }): TeamEventSnapshot {
  return {
    id: overrides.id ?? `evt-${overrides.nodeKey}-${overrides.action ?? "start"}`,
    action: "start",
    status: "ok",
    detail: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function message(overrides: Partial<TeamMessageSnapshot> & { nodeKey: string }): TeamMessageSnapshot {
  return {
    id: overrides.id ?? `msg-${overrides.nodeKey}`,
    role: "assistant",
    content: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function roleOf(team: TeamStatus, roleId: string) {
  const role = team.roles.find((role) => role.roleId === roleId)
  if (!role) throw new Error(`角色 ${roleId} 不在编制内`)
  return role
}

function chip(team: TeamStatus, roleId: string, label: string): string {
  const output = roleOf(team, roleId).outputs.find((output) => output.label === label)
  if (!output) throw new Error(`角色 ${roleId} 缺少指标「${label}」`)
  return output.value
}

describe("deriveTeamStatus · working（pendingAction 归属 + run 执行中）", () => {
  it("finalize_brief → 创意总监 working，文案「正在整理设计简报」，activeRoleId 指向它", () => {
    const team = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: { stage: "clarify", status: "running", pendingAction: { kind: "finalize_brief" } },
      events: [],
      messages: [],
    })
    const director = roleOf(team, "creative_director")
    expect(director.state).toBe("working")
    expect(director.currentTask).toBe("正在整理设计简报")
    expect(team.activeRoleId).toBe("creative_director")
  })

  it("clarify_turn → working「正在根据你的回答整理追问」", () => {
    const team = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: { stage: "clarify", status: "running", pendingAction: { kind: "clarify_turn" } },
      events: [],
      messages: [],
    })
    expect(roleOf(team, "creative_director").currentTask).toBe("正在根据你的回答整理追问")
  })

  it("gen_style_spec → 风格策划 working「正在拟定 3 个风格规范方向与示例图」", () => {
    const team = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: { stage: "draft", status: "running", pendingAction: { kind: "gen_style_spec" } },
      events: [],
      messages: [],
    })
    const planner = roleOf(team, "style_director")
    expect(planner.state).toBe("working")
    expect(planner.currentTask).toBe("正在拟定 3 个风格规范方向与示例图")
  })

  it("design_drafts → 初稿设计师 working；design_finals → 终稿细化师 working", () => {
    const drafts = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: { stage: "draft", status: "running", pendingAction: { kind: "design_drafts" } },
      events: [],
      messages: [],
    })
    expect(roleOf(drafts, "prompt_designer").currentTask).toBe("正在逐张撰写画面提示词（首次撰写即终稿）")

    const finals = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: { stage: "final", status: "running", pendingAction: { kind: "design_finals" } },
      events: [],
      messages: [],
    })
    expect(roleOf(finals, "final_refiner").currentTask).toBe("正在把初稿细化为结构化终稿（存量流程）")
  })

  it("最新事件为 start 且其后无 done/fail、run 执行中 → working（任务取事件详情）", () => {
    const team = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: { stage: "art", status: "running" },
      events: [event({ nodeKey: "artist", action: "start", detail: "开始生成第 1 张卡面" })],
      messages: [],
    })
    const artist = roleOf(team, "artist")
    expect(artist.state).toBe("working")
    expect(artist.currentTask).toBe("开始生成第 1 张卡面")
    expect(team.activeRoleId).toBe("artist")
  })
})

describe("deriveTeamStatus · waiting_user（等待用户确认）", () => {
  it("waiting_human + finalize_brief → 创意总监「等待你确认简报」", () => {
    const team = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: { stage: "clarify", status: "waiting_human", pendingAction: { kind: "finalize_brief" } },
      events: [],
      messages: [],
    })
    const director = roleOf(team, "creative_director")
    expect(director.state).toBe("waiting_user")
    expect(director.currentTask).toBe("等待你确认简报")
  })

  it("waiting_human + 澄清追问消息（无 pendingAction）→「等待你回答问题」，追问按问号行计数", () => {
    const team = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: { stage: "clarify", status: "waiting_human" },
      events: [],
      messages: [
        message({
          nodeKey: "creative_director",
          content: "为了把这套牌做得更准确，请先确认：\n【主题】整套牌的世界观方向？\n【风格】首选艺术媒介？",
        }),
      ],
    })
    const director = roleOf(team, "creative_director")
    expect(director.state).toBe("waiting_user")
    expect(director.currentTask).toBe("等待你回答问题")
    expect(chip(team, "creative_director", "追问")).toBe("2 条")
    expect(chip(team, "creative_director", "简报")).toBe("未生成")
  })

  it("waiting_human + 3 个候选风格规范已产出 → 风格策划等待选择方向", () => {
    const team = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: {
        stage: "draft",
        status: "waiting_human",
        directions: [{ id: "moon" }, { id: "star" }, { id: "market" }],
      },
      events: [event({ nodeKey: "style_director", action: "done", detail: "已拟定 3 个候选方向" })],
      messages: [message({ nodeKey: "style_director", meta: { kind: "directions" } })],
    })
    const planner = roleOf(team, "style_director")
    expect(planner.state).toBe("waiting_user")
    expect(planner.currentTask).toBe("等待你选择风格规范方向")
    expect(chip(team, "style_director", "风格规范")).toBe("3 个候选")
  })

  it("meta.questions 优先于问号行计数；brief 类消息不计追问", () => {
    const team = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: { stage: "clarify", status: "waiting_human" },
      events: [],
      messages: [
        message({
          nodeKey: "creative_director",
          meta: { kind: "clarify", questions: ["q1", "q2", "q3"] },
          content: "追问如下：\n一？\n二？",
        }),
        message({
          nodeKey: "creative_director",
          meta: { kind: "brief" },
          content: "创作要点简报：\n媒介？\n色调？\n氛围？",
        }),
      ],
    })
    expect(chip(team, "creative_director", "追问")).toBe("3 条")
  })
})

describe("deriveTeamStatus · done / error / idle", () => {
  it("阶段推进到 final 后，style_director（draft 阶段）→ done，任务「已完成」", () => {
    const team = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: { stage: "final", status: "waiting_human" },
      events: [event({ nodeKey: "style_director", action: "done", detail: "风格规范书已定稿" })],
      messages: [],
    })
    const planner = roleOf(team, "style_director")
    expect(planner.state).toBe("done")
    expect(planner.currentTask).toBe("已完成")
    expect(planner.latestOutput).toBe("风格规范书已定稿")
  })

  it("fail 事件 → error，任务取失败详情", () => {
    const team = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: { stage: "art", status: "running" },
      events: [
        event({ nodeKey: "artist", action: "start" }),
        event({ nodeKey: "artist", action: "fail", detail: "生图接口超时" }),
      ],
      messages: [],
    })
    const artist = roleOf(team, "artist")
    expect(artist.state).toBe("error")
    expect(artist.currentTask).toBe("生图接口超时")
  })

  it("fail 被后续 done 接管 → 不再是 error（同阶段最新事件收尾 → done）", () => {
    const team = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: { stage: "art", status: "running" },
      events: [
        event({ nodeKey: "artist", action: "fail", detail: "第 3 张构图偏离" }),
        event({ nodeKey: "artist", action: "done", detail: "第 3 张已通过" }),
      ],
      messages: [],
    })
    expect(roleOf(team, "artist").state).toBe("done")
  })

  it("run.error 且最后待执行动作归属该角色 → error", () => {
    const team = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: {
        stage: "clarify",
        status: "failed",
        error: "澄清队列超时",
        pendingAction: { kind: "clarify_turn" },
      },
      events: [],
      messages: [],
    })
    const director = roleOf(team, "creative_director")
    expect(director.state).toBe("error")
    expect(director.currentTask).toBe("澄清队列超时")
  })

  it("未来阶段角色 → idle，任务含其所属阶段名", () => {
    const team = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: { stage: "clarify", status: "waiting_human" },
      events: [],
      messages: [],
    })
    const artist = roleOf(team, "artist")
    expect(artist.state).toBe("idle")
    expect(artist.currentTask).toBe("待命，将在「生图与评审」阶段加入")
    expect(roleOf(team, "compositor").currentTask).toBe("待命，将在「融合与交付」阶段加入")
    expect(team.usedCount).toBe(8)
    expect(team.participatedCount).toBe(0)
    expect(team.activeRoleId).toBeNull()
  })
})

describe("deriveTeamStatus · 产出指标与计数", () => {
  const items: TeamItemSnapshot[] = [
    { id: "item-1", index: 0, finalRoundId: "round-1" },
    { id: "item-2", index: 1, finalRoundId: null },
    { id: "item-3", index: 2, finalRoundId: "round-2" },
    { id: "item-4", index: 3, frameStatus: "framed" },
    { id: "item-5", index: 4, frameStatus: "framed" },
  ]
  const assets = [{ id: "asset-1", kind: "border", url: "https://cdn.example/border.png", name: "边框" }]

  const team = deriveTeamStatus({
    roles: ROLES,
    stages: STAGES,
    run: { stage: "art", status: "running", brief: "深蓝+金色星象的神秘学体系", directions: [{ id: "moon" }] },
    events: [
      event({ nodeKey: "review_panel", action: "done" }),
      event({ nodeKey: "review_panel", action: "done" }),
      event({ nodeKey: "review_panel", action: "done" }),
      event({ nodeKey: "supervisor", action: "confirm" }),
      event({ nodeKey: "prompt_designer", action: "done" }),
      event({ nodeKey: "prompt_designer", action: "done" }),
      event({ nodeKey: "final_refiner", action: "done" }),
    ],
    messages: [
      message({ nodeKey: "creative_director", content: "已按你的回答整理出创作简报，请确认。" }),
    ],
    items,
    assets,
    cardTotal: 78,
  })

  it("画师：卡面 X/78 按 finalRoundId 计数，套件资产 N/6", () => {
    expect(chip(team, "artist", "卡面")).toBe("2/78")
    expect(chip(team, "artist", "套件资产")).toBe("1/6")
  })

  it("评审团/合成师/初稿设计师/终稿细化师/总控按事件与条目计数", () => {
    expect(chip(team, "review_panel", "已评审")).toBe("3 张")
    expect(chip(team, "compositor", "AI 融合")).toBe("2/78 张")
    expect(chip(team, "prompt_designer", "画面提示词")).toBe("2 批")
    expect(chip(team, "final_refiner", "终稿（存量）")).toBe("1 批")
    expect(chip(team, "supervisor", "裁决")).toBe("1 次")
  })

  it("创意总监：简报已生成；风格策划：候选方向计数", () => {
    expect(chip(team, "creative_director", "简报")).toBe("已生成")
    expect(chip(team, "style_director", "风格规范")).toBe("1 个候选")
  })

  it("usedCount = 编制总数；participatedCount 只统计有事件/消息的角色", () => {
    expect(team.usedCount).toBe(8)
    // 有事件：review_panel / supervisor / prompt_designer / final_refiner；有消息：creative_director
    expect(team.participatedCount).toBe(5)
    expect(roleOf(team, "artist").participated).toBe(false)
  })

  it("latestOutput 取最新 assistant 消息（截断 ~80 字）", () => {
    expect(roleOf(team, "creative_director").latestOutput).toBe(
      "已按你的回答整理出创作简报，请确认。",
    )
  })

  it("超长产出截断到 80 字并补省略号", () => {
    const long = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: { stage: "art", status: "running" },
      events: [],
      messages: [message({ nodeKey: "artist", content: "深".repeat(100) })],
    })
    const latest = roleOf(long, "artist").latestOutput
    expect(latest).toBeDefined()
    expect(latest).toHaveLength(81)
    expect(latest?.endsWith("…")).toBe(true)
  })

  it("事件按 createdAt 升序排布（字符串/Date 混排稳定）；最新事件决定状态", () => {
    const mixed = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: { stage: "art", status: "running" },
      events: [
        event({ nodeKey: "artist", action: "done", detail: "第 1 张完成", createdAt: new Date("2026-01-01T00:02:00.000Z") }),
        event({ nodeKey: "artist", action: "start", detail: "开始第 1 张", createdAt: "2026-01-01T00:01:00.000Z" }),
      ],
      messages: [],
    })
    const artist = roleOf(mixed, "artist")
    expect(artist.events.map((event) => event.action)).toEqual(["start", "done"])
    // 最新事件是 done（不是 start）→ 不判 working；同阶段收尾 → done
    expect(artist.state).toBe("done")
    expect(artist.latestOutput).toBe("第 1 张完成")
  })
})

describe("deriveTeamStatus · 多阶段角色（done 判定按 lastPos）", () => {
  // supervisor 贯穿 art(3) + compose(4)：以最后一个所属阶段为准。
  // 此前按 firstPos 判定，compose 阶段执行中会被误标「已完成」。
  it("supervisor 在 compose 阶段执行中不被误标 done（最新事件是 start）", () => {
    const team = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: { stage: "compose", status: "waiting_human", pendingAction: { kind: "compose_preview" } },
      events: [
        event({ id: "sup-art", nodeKey: "supervisor", action: "done", detail: "三审裁决放行", createdAt: "2026-01-01T00:00:00.000Z" }),
        event({ id: "sup-compose", nodeKey: "supervisor", action: "start", detail: "预览融合跟进", createdAt: "2026-01-02T00:00:00.000Z" }),
      ],
      messages: [],
    })
    expect(roleOf(team, "supervisor").state).not.toBe("done")
  })

  it("supervisor 在 compose 阶段收尾（最新事件 done）判 done", () => {
    const team = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: { stage: "compose", status: "waiting_human", pendingAction: { kind: "compose_batch" } },
      events: [
        event({ id: "sup-art", nodeKey: "supervisor", action: "done", detail: "三审裁决放行", createdAt: "2026-01-01T00:00:00.000Z" }),
        event({ id: "sup-compose", nodeKey: "supervisor", action: "done", detail: "全套交付完成", createdAt: "2026-01-02T00:00:00.000Z" }),
      ],
      messages: [],
    })
    expect(roleOf(team, "supervisor").state).toBe("done")
  })

  it("style_director 在 draft 阶段产出候选方向后进入 waiting_user 兜底（优先于 done）", () => {
    const team = deriveTeamStatus({
      roles: ROLES,
      stages: STAGES,
      run: { stage: "draft", status: "waiting_human", directions: [{ id: "a" }, { id: "b" }, { id: "c" }] },
      events: [event({ nodeKey: "style_director", action: "done", detail: "已拟定 3 个候选方向" })],
      messages: [message({ nodeKey: "style_director", meta: { kind: "directions" } })],
    })
    expect(roleOf(team, "style_director").state).toBe("waiting_user")
  })
})
