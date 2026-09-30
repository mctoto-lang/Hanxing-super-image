/**
 * 模板团队状态推导（纯函数 · 零依赖）
 *
 * 把一次模板项目的运行快照（run + 事件 + 消息 + 卡面/资产）折叠成
 * 「本项目使用了哪些角色 Agent、各自什么状态、正在干什么」，供团队面板
 * （agent-team-panel）与角色详情侧边栏（agent-role-sheet）渲染，替代
 * 旧的大阶段流水线视角。
 *
 * 单角色状态判定（按序命中即止）：
 * - working      run 排队/执行中，且待执行动作（pendingAction）归属该角色；
 *                或该角色最新事件是 start 而其后没有 done/fail，且 run 仍在
 *                排队/执行中；
 * - error        角色最新事件是 fail（或 status=error，未被后续 done 接管）；
 *                或 run 带 error 且最后待执行动作归属该角色；
 * - waiting_user run waiting_human、角色属于当前阶段，且已产出等待用户确认
 *                的内容（创意总监的澄清追问/简报；世界观策划的内容方向）；
 *                pendingAction 指向该角色时同样成立（等待用户完成该动作）；
 * - done         角色已参与，且其所属阶段都在当前阶段之前；或虽在当前阶段，
 *                但最新事件已是 done/confirm 收尾；
 * - idle         其余情况（未来阶段待命）。
 *
 * 纯数据进出：createdAt 接受 Date 或 ISO 字符串（服务端序列化后仍可用）；
 * 不发请求、不依赖组件运行时，可在服务端与单测中直接调用。输入类型为
 * 结构化最小面，刻意不 import server action 的返回类型，避免与其演进
 * 互相锁死。
 */

// ---------------------------------------------------------------------------
// 输入快照（结构化最小面）
// ---------------------------------------------------------------------------

/** 角色编制条目（DeckTemplateRole 的结构子集） */
export interface TeamRoleInput {
  id: string
  name: string
  duty: string
  /** 编制分组（planning / production / qa / delivery / control） */
  group: string
}

/** 流程阶段条目（数组顺序即执行顺序；DeckTemplateStage 的结构子集） */
export interface TeamStageInput {
  id: string
  name: string
  /** 参与角色 id */
  roleIds: readonly string[]
}

/** 运行快照（getTemplateWorkspaceAction 返回 run 的结构子集） */
export interface TeamRunSnapshot {
  /** 当前阶段 id；null = 尚未推进 */
  stage: string | null
  /** queued | running | waiting_human | completed | failed | cancelled … */
  status: string
  /** 等待中的动作（clarify_turn / finalize_brief / gen_directions / produce_cards …） */
  pendingAction?: { kind: string; feedback?: string; phase?: string } | null
  /** 运行级错误（等待用户动作期间被记录时用于 error 判定） */
  error?: string | null
  /** 已产出的内容方向（world 阶段） */
  directions?: unknown[]
  /** 已生成的创作简报（clarify 阶段） */
  brief?: string | null
}

/** 事件快照（agentEvents 子集；nodeKey = 角色 id） */
export interface TeamEventSnapshot {
  id: string
  nodeKey: string | null
  /** start | done | fail | retry | fallback | confirm | regen … */
  action: string
  status: string
  detail: string | null
  createdAt: Date | string
  itemId?: string | null
}

/** 消息快照（agentMessages 子集；nodeKey = 角色 id） */
export interface TeamMessageSnapshot {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  nodeKey: string | null
  meta?: {
    kind?: "clarify" | "brief" | "directions" | (string & {})
    questions?: unknown[]
    count?: number
  } | null
  createdAt: Date | string
}

/** 卡面条目快照（agentRunItems 子集） */
export interface TeamItemSnapshot {
  id: string
  index: number
  name?: string | null
  status?: string | null
  framedImageUrl?: string | null
  frameStatus?: string | null
  /** 非空 = 该卡已确认定稿轮次 */
  finalRoundId?: string | null
}

/** 套件资产快照（agentAssets 子集；边框/牌背/牌盒五视图） */
export interface TeamAssetSnapshot {
  id: string
  kind: string
  url: string
  name?: string | null
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

export type RoleRuntimeState = "idle" | "working" | "waiting_user" | "done" | "error"

/** 产出指标芯片（label + value，如「追问 · 3 条」） */
export interface RoleStatusOutput {
  label: string
  value: string
}

/** 单个角色 Agent 的即时状态（团队卡片 / 角色详情侧边栏共用） */
export interface RoleStatus {
  roleId: string
  name: string
  duty: string
  group: string
  state: RoleRuntimeState
  /** 一句当前任务描述（中文，可直接展示） */
  currentTask: string
  /** 产出指标芯片 */
  outputs: RoleStatusOutput[]
  /** 最新产出摘录：该角色最新 assistant 消息（截断 ~80 字），否则最近 done 事件详情 */
  latestOutput: string | null
  /** 该角色的事件时间线（按时间升序） */
  events: TeamEventSnapshot[]
  /** 是否实际参与过本项目（有事件或消息） */
  participated: boolean
}

/** 团队面板数据（deriveTeamStatus 的返回值） */
export interface TeamStatus {
  roles: RoleStatus[]
  /** 编制内角色总数（usedCount） */
  usedCount: number
  /** 已实际参与的角色数（participatedCount） */
  participatedCount: number
  /** 当前正在执行的角色 id；无则 null */
  activeRoleId: string | null
}

// ---------------------------------------------------------------------------
// 常量与映射（口径对齐塔罗模板）
// ---------------------------------------------------------------------------

/** 成品卡面总数（78 张 = 22 大阿卡纳 + 56 小阿卡纳） */
const CARD_TOTAL = 78
/** 套件资产总数（边框/牌背/牌盒正面/背面/侧面/顶面） */
const ASSET_TOTAL = 6

/** 待执行动作 → 责任角色（与 pendingAction.kind 约定对齐） */
const PENDING_ACTION_ROLES: Record<string, string> = {
  clarify_turn: "creative_director",
  finalize_brief: "creative_director",
  gen_directions: "world_planner",
  compose_preview: "compositor",
  compose_batch: "compositor",
  produce_cards: "artist",
}

/** 收尾动作：其后无更新事件即视为该角色完成 */
const FINISH_ACTIONS = new Set(["done", "confirm"])

/** 工作中：待执行动作 → 进行中文案 */
function workingTaskText(kind: string, directionCount: number, stageName: string | null, phase?: string): string {
  if (kind === "clarify_turn") return "正在根据你的回答整理追问"
  if (kind === "finalize_brief") return "正在整理设计简报"
  if (kind === "gen_directions") return `正在构思 ${directionCount > 0 ? directionCount : 3} 个内容方向`
  if (kind === "produce_cards") return phase === "full" ? "正在生产全套卡面（生图 + 三审 + 裁决）" : "正在生成风格小样"
  return stageName ? `正在执行「${stageName}」阶段任务` : "正在执行阶段任务"
}

/** 等待用户：待执行动作 / 等待语境 → 文案 */
function waitingTaskText(kind: string | null): string {
  if (kind === "clarify_turn") return "等待你回答问题"
  if (kind === "finalize_brief") return "等待你确认简报"
  if (kind === "gen_directions") return "等待你选择内容方向"
  if (kind === "produce_cards") return "等待你确认小样风格"
  return "等待你确认"
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** Date | ISO 字符串 → 毫秒时间戳（不可解析返回 0，保证排序稳定） */
function toTime(value: Date | string): number {
  if (value instanceof Date) return value.getTime()
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

/** 压平空白并截断到 ~max 字符（超长补省略号） */
function truncate(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/**
 * 单条澄清消息的追问数：meta.questions / meta.count 优先（澄清类消息），
 * 无 meta 的旧消息按正文中含问号的行数兜底；brief/directions 类消息不计。
 */
function messageQuestionCount(message: TeamMessageSnapshot): number {
  const meta = message.meta
  if (meta?.kind && meta.kind !== "clarify") return 0
  if (meta) {
    if (Array.isArray(meta.questions)) return meta.questions.length
    if (typeof meta.count === "number") return meta.count
  }
  return message.content.split("\n").filter((line) => /[?？]/.test(line)).length
}

// ---------------------------------------------------------------------------
// 主推导
// ---------------------------------------------------------------------------

export function deriveTeamStatus(input: {
  roles: readonly TeamRoleInput[]
  stages: readonly TeamStageInput[]
  run: TeamRunSnapshot
  events: readonly TeamEventSnapshot[]
  messages: readonly TeamMessageSnapshot[]
  items?: readonly TeamItemSnapshot[]
  assets?: readonly TeamAssetSnapshot[]
}): TeamStatus {
  const { roles, stages, run, events, messages } = input
  const items = input.items ?? []
  const assets = input.assets ?? []

  // 统一按时间升序（Date / 字符串混排也稳定）
  const sortedEvents = [...events].sort((a, b) => toTime(a.createdAt) - toTime(b.createdAt))
  const sortedMessages = [...messages].sort((a, b) => toTime(a.createdAt) - toTime(b.createdAt))

  // 按角色归组（nodeKey = 角色 id）
  const eventsByRole = new Map<string, TeamEventSnapshot[]>()
  for (const event of sortedEvents) {
    if (!event.nodeKey) continue
    const list = eventsByRole.get(event.nodeKey)
    if (list) list.push(event)
    else eventsByRole.set(event.nodeKey, [event])
  }
  const messagesByRole = new Map<string, TeamMessageSnapshot[]>()
  for (const message of sortedMessages) {
    if (!message.nodeKey) continue
    const list = messagesByRole.get(message.nodeKey)
    if (list) list.push(message)
    else messagesByRole.set(message.nodeKey, [message])
  }

  // 阶段位置（数组顺序即流程顺序；未知阶段记 -1，所有先后判定全部收敛）
  const stagePos = (stageId: string | null | undefined): number =>
    stageId ? stages.findIndex((stage) => stage.id === stageId) : -1
  const currentIndex = stagePos(run.stage)
  const currentStageName = currentIndex >= 0 ? (stages[currentIndex]?.name ?? null) : null

  const pendingKind = run.pendingAction?.kind ?? null
  const pendingRoleId = pendingKind ? (PENDING_ACTION_ROLES[pendingKind] ?? null) : null
  const runActive = run.status === "queued" || run.status === "running"
  const runWaiting = run.status === "waiting_human"
  const directionCount = run.directions?.length ?? 0

  const roleStatuses = roles.map<RoleStatus>((role) => {
    const roleEvents = eventsByRole.get(role.id) ?? []
    const roleMessages = messagesByRole.get(role.id) ?? []
    const participated = roleEvents.length > 0 || roleMessages.length > 0
    const latest = roleEvents.length > 0 ? (roleEvents[roleEvents.length - 1] as TeamEventSnapshot) : null
    const latestAssistant = [...roleMessages]
      .reverse()
      .find((message) => message.role === "assistant" && message.content.trim().length > 0)
    const latestDone = [...roleEvents].reverse().find((event) => FINISH_ACTIONS.has(event.action))
    const doneCount = roleEvents.filter(
      (event) => FINISH_ACTIONS.has(event.action) && event.status !== "error",
    ).length

    // 角色参与的阶段位置（升序）
    const stagePositions = stages
      .map((stage, index) => (stage.roleIds.includes(role.id) ? index : -1))
      .filter((index) => index >= 0)
    // 多阶段角色（如贯穿 art+compose 的 supervisor）以最后一个所属阶段为准：
    // 中间阶段执行中不算「已完成」（文件头语义：其所属阶段都在当前阶段之前）
    const lastPos = stagePositions[stagePositions.length - 1] ?? -1

    // -- 等待用户语境（仅 waiting_human 时可能成立） ------------------------
    let waitingKind: string | null = null
    if (runWaiting) {
      if (pendingKind && pendingRoleId === role.id) {
        waitingKind = pendingKind
      } else if (stagePositions.includes(currentIndex)) {
        // 无显式待执行动作时，按「已产出待确认内容」的语境兜底
        const hasClarifyOutput =
          role.id === "creative_director" &&
          (roleMessages.some(
            (message) =>
              message.role === "assistant" &&
              (message.meta?.kind === "clarify" || (!message.meta && /[?？]/.test(message.content))),
          ) ||
            !!run.brief)
        const hasDirectionsOutput =
          role.id === "world_planner" &&
          (directionCount > 0 ||
            roleMessages.some(
              (message) => message.role === "assistant" && message.meta?.kind === "directions",
            ))
        if (hasClarifyOutput) waitingKind = run.brief ? "finalize_brief" : "clarify_turn"
        else if (hasDirectionsOutput) waitingKind = "gen_directions"
      }
    }

    // -- 状态判定（优先级见文件头） -----------------------------------------
    let state: RoleRuntimeState
    if (runActive && (pendingRoleId === role.id || latest?.action === "start")) {
      state = "working"
    } else if (
      (latest && (latest.action === "fail" || latest.status === "error")) ||
      (run.error && pendingRoleId === role.id)
    ) {
      state = "error"
    } else if (waitingKind) {
      state = "waiting_user"
    } else if (
      participated &&
      ((lastPos !== -1 && lastPos < currentIndex) ||
        (lastPos === currentIndex && latest !== null && FINISH_ACTIONS.has(latest.action)))
    ) {
      state = "done"
    } else {
      state = "idle"
    }

    // -- 当前任务文案 --------------------------------------------------------
    let currentTask: string
    if (state === "working") {
      currentTask =
        pendingKind && pendingRoleId === role.id
          ? workingTaskText(pendingKind, directionCount, currentStageName, run.pendingAction?.phase)
          : (latest?.detail ?? (currentStageName ? `正在执行「${currentStageName}」阶段任务` : "正在执行阶段任务"))
    } else if (state === "error") {
      currentTask = latest?.detail ?? run.error ?? "执行出错，请查看事件详情"
    } else if (state === "waiting_user") {
      currentTask = waitingTaskText(waitingKind)
    } else if (state === "done") {
      currentTask = "已完成"
    } else {
      // 待命：指向该角色下一个（或当前）投入的阶段
      const nextPos = stagePositions.find((index) => index >= currentIndex) ?? lastPos
      if (nextPos === -1) currentTask = "待命"
      else if (nextPos === currentIndex) currentTask = `待命中，随时投入「${stages[nextPos]?.name ?? ""}」阶段工作`
      else currentTask = `待命，将在「${stages[nextPos]?.name ?? ""}」阶段加入`
    }

    // -- 产出指标（按角色各有一套口径） --------------------------------------
    const outputs: RoleStatusOutput[] = []
    switch (role.id) {
      case "creative_director": {
        const questionCount = roleMessages
          .filter((message) => message.role === "assistant")
          .reduce((sum, message) => sum + messageQuestionCount(message), 0)
        outputs.push({ label: "追问", value: `${questionCount} 条` })
        outputs.push({ label: "简报", value: run.brief ? "已生成" : "未生成" })
        break
      }
      case "world_planner":
        outputs.push({ label: "内容方向", value: `${directionCount} 个` })
        break
      case "prompt_designer":
        outputs.push({ label: "提示词", value: `${doneCount} 批` })
        break
      case "artist": {
        const confirmedCards = items.filter((item) => item.finalRoundId).length
        outputs.push({ label: "卡面", value: `${confirmedCards}/${CARD_TOTAL}` })
        outputs.push({ label: "套件资产", value: `${assets.length}/${ASSET_TOTAL}` })
        break
      }
      case "review_panel":
        outputs.push({ label: "已评审", value: `${doneCount} 张` })
        break
      case "compositor": {
        const framedCards = items.filter((item) => item.frameStatus === "framed").length
        outputs.push({ label: "AI 融合", value: `${framedCards}/${CARD_TOTAL} 张` })
        break
      }
      case "supervisor":
        outputs.push({ label: "裁决", value: `${doneCount} 次` })
        break
      default:
        if (participated) outputs.push({ label: "事件", value: `${roleEvents.length} 条` })
    }

    // -- 最新产出摘录 --------------------------------------------------------
    const latestOutput = latestAssistant
      ? truncate(latestAssistant.content)
      : latestDone?.detail
        ? truncate(latestDone.detail)
        : null

    return {
      roleId: role.id,
      name: role.name,
      duty: role.duty,
      group: role.group,
      state,
      currentTask,
      outputs,
      latestOutput,
      events: roleEvents,
      participated,
    }
  })

  return {
    roles: roleStatuses,
    usedCount: roleStatuses.length,
    participatedCount: roleStatuses.filter((role) => role.participated).length,
    activeRoleId: roleStatuses.find((role) => role.state === "working")?.roleId ?? null,
  }
}
