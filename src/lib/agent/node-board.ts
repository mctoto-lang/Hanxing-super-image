/**
 * 经典 8 节点看板推导（纯函数 · 零依赖）
 *
 * 旧版 RunBoard 的 8 张 Agent 卡数据来自 agent_node_run 表；该表只随
 * 经典全流程写入（模板流程未落节点行），因此这里从模板工作台快照
 * （run + items）推导同名 8 节点的状态与进度，恢复旧版观感。
 * 节点 id 沿用旧版命名，实际对应模板新角色（映射见下方
 * NODE_TO_TEMPLATE_ROLE / templateRoleForNode）：
 *
 * - style（创意总监）      ← 澄清 + 简报（澄清期等待用户，简报确认即完成）
 * - structure（风格策划）  ← 风格规范书 + 卡牌清单
 * - copywriter（初稿设计师/终稿细化师） ← 逐张提示词（按待执行动作细分：
 *   初稿期 design_drafts 打开初稿设计师，终稿/生产期打开终稿细化师）
 * - imagegen（画师）       ← 有成图的卡（小样阶段按小样口径）
 * - review_*（评审面板）   ← 进入过评审的卡（三卡共用同一口径，近似）
 * - supervisor（总控裁决/合成师） ← 已定终版的卡（融合/资产期
 *   compose_* / asset_gen 细分打开合成师）
 *
 * 阶段归一：存量 run 的旧阶段名 world → draft、prompt → final 后再比对
 * （stagePos）；小样阶段（phase=sample）按小样子集统计，全套/交付按全部
 * （scopeOf）。
 * 近似口径（与旧版逐节点实时的区别）已在注释标明；纯数据进出，可在
 * 服务端与单测中直接调用（输入类型为结构化最小面，同 team-status 先例）。
 */

/** 经典流水线节点 id（与旧版 team.ts TEAM_AGENTS 顺序一致） */
export const CLASSIC_NODE_KEYS = [
  "style",
  "structure",
  "copywriter",
  "imagegen",
  "review_content",
  "review_aesthetic",
  "review_consistency",
  "supervisor",
] as const

export type ClassicNodeKey = (typeof CLASSIC_NODE_KEYS)[number]

/** 节点卡状态（在旧版 idle/running/done/failed/skipped 基础上增加 waiting=等待用户） */
export type NodeBoardStatus = "idle" | "running" | "waiting" | "done" | "failed"

/** 运行快照（getTemplateWorkspaceAction 返回 run 的结构子集） */
export interface NodeBoardRunSnapshot {
  stage: string | null
  status: string
  phase: string
  brief: string | null
  directions?: unknown[]
  selectedDirectionId: string | null
  pendingAction: { kind: string; phase?: string } | null
  error: string | null
}

/** 卡面条目快照（结构子集） */
export interface NodeBoardItemSnapshot {
  status: string
  currentPrompt: string | null
  promptSource?: string | null
  latestRoundId: string | null
  latestImageUrl: string | null
  finalRoundId: string | null
  roundsUsed: number
  errorMessage: string | null
  isSample: boolean
}

/** 单张节点卡数据（agent-cards-grid 渲染输入） */
export interface NodeCardInfo {
  nodeKey: ClassicNodeKey
  status: NodeBoardStatus
  /** 已处理数（total 为 0 时网格显示占位 "—"） */
  processed: number
  total: number
  failedCount: number
  retryCount: number
  lastError: string | null
}

/** 待执行动作 → 出错时归属的节点（其余节点保持自身进度状态） */
const ERROR_NODE_BY_ACTION: Record<string, ClassicNodeKey> = {
  clarify_turn: "style",
  finalize_brief: "style",
  gen_style_spec: "structure",
  design_drafts: "copywriter",
  design_finals: "copywriter",
  produce_cards: "imagegen",
  asset_gen: "supervisor",
  compose_preview: "supervisor",
  compose_batch: "supervisor",
  // 旧动作（存量 run 过渡期）
  gen_directions: "structure",
  design_prompts: "copywriter",
}

/** 经典节点 → 模板角色（点击节点卡打开对应 AgentRoleSheet） */
export const NODE_TO_TEMPLATE_ROLE: Record<ClassicNodeKey, string> = {
  style: "creative_director",
  structure: "style_director",
  copywriter: "final_refiner",
  imagegen: "artist",
  review_content: "review_panel",
  review_aesthetic: "review_panel",
  review_consistency: "review_panel",
  supervisor: "supervisor",
}

/**
 * 节点卡点击 → 模板角色（按当前待执行动作细分）：
 * - copywriter：初稿期（design_drafts）打开初稿设计师，终稿/生产期打开终稿细化师；
 * - supervisor：融合/资产期（compose_* / asset_gen）打开合成师，其余打开总控。
 */
export function templateRoleForNode(nodeKey: ClassicNodeKey, pendingKind: string | null): string {
  if (nodeKey === "copywriter") {
    return pendingKind === "design_drafts" || pendingKind === "design_prompts"
      ? "prompt_designer"
      : NODE_TO_TEMPLATE_ROLE.copywriter
  }
  if (nodeKey === "supervisor") {
    return pendingKind === "compose_preview" || pendingKind === "compose_batch" || pendingKind === "asset_gen"
      ? "compositor"
      : NODE_TO_TEMPLATE_ROLE.supervisor
  }
  return NODE_TO_TEMPLATE_ROLE[nodeKey]
}

/** 新五阶段顺序（存量 run 的 world/prompt 归一化后比对） */
const STAGE_ORDER = ["clarify", "draft", "final", "art", "compose"]

function stagePos(stage: string | null): number {
  if (!stage) return -1
  const normalized = stage === "world" ? "draft" : stage === "prompt" ? "final" : stage
  return STAGE_ORDER.indexOf(normalized)
}

/** 小样阶段按小样口径统计，全套/交付按全套 */
function scopeOf(run: NodeBoardRunSnapshot, items: readonly NodeBoardItemSnapshot[]): NodeBoardItemSnapshot[] {
  return run.phase === "sample" ? items.filter((item) => item.isSample) : [...items]
}

/**
 * 推导经典 8 节点卡片数据。
 *
 * @param input.run       工作台 run 快照
 * @param input.items     卡面清单快照（clarify/world 阶段可为空数组）
 * @param input.cardTotal 卡组目标张数（run.input.cardCount；清单未建时作为
 *                        structure/copywriter 的 total 展示基准）
 */
export function deriveClassicNodeBoard(input: {
  run: NodeBoardRunSnapshot
  items: readonly NodeBoardItemSnapshot[]
  cardTotal: number
}): NodeCardInfo[] {
  const { run, items } = input
  const cardTotal = Math.max(0, Math.round(input.cardTotal))
  const pos = stagePos(run.stage)
  const busy = run.status === "queued" || run.status === "running"
  const pendingKind = run.pendingAction?.kind ?? null
  const isTransient = (status: string) => ["pending", "drafting", "generating", "reviewing"].includes(status)
  const errorNode = run.error && pendingKind ? (ERROR_NODE_BY_ACTION[pendingKind] ?? null) : null

  const failedCount = items.filter((item) => item.status === "failed" || item.status === "cancelled").length
  const retryCount = items.reduce((sum, item) => sum + Math.max(0, item.roundsUsed - 1), 0)
  const lastError = run.error ?? items.find((item) => item.errorMessage)?.errorMessage ?? null

  const withFinal = items.filter(
    (item) => item.promptSource === "final" || !!(item.currentPrompt && item.currentPrompt.includes("[2] 画面内容")),
  ).length
  const scope = scopeOf(run, items)
  const withImage = scope.filter((item) => !!item.latestImageUrl).length
  const withRound = scope.filter((item) => !!item.latestRoundId).length
  const withFinalRound = scope.filter((item) => !!item.finalRoundId).length

  // -- style（创意总监）：澄清 + 简报确认即完成 ----------------------------
  let styleStatus: NodeBoardStatus
  if (pos >= 1 || run.selectedDirectionId) styleStatus = "done"
  else {
    // clarify 阶段：AI 分析中 → running；简报/追问就绪 → 等待用户
    styleStatus =
      busy && (pendingKind === "clarify_turn" || pendingKind === "finalize_brief") ? "running" : "waiting"
  }

  // -- structure（风格策划）：风格规范书 + 78 张清单齐备即完成 --------------
  let structureStatus: NodeBoardStatus
  if (items.length >= cardTotal && run.selectedDirectionId) structureStatus = "done"
  else if (pos === 1) structureStatus = busy && pendingKind === "gen_style_spec" ? "running" : "waiting"
  else structureStatus = "idle"

  // -- copywriter（终稿细化师）：78 张终稿齐备即完成（打回重细化按需进行） ---
  let copywriterStatus: NodeBoardStatus
  if (items.length >= cardTotal && withFinal >= cardTotal) copywriterStatus = "done"
  else if (pos >= 1)
    copywriterStatus =
      busy && ["design_finals", "design_drafts", "produce_cards"].includes(pendingKind ?? "") ? "running" : "waiting"
  else copywriterStatus = "idle"

  // -- 生产三兄弟（生图 / 三审 / 裁决）：art 阶段起按 scope 口径 ----------
  // 完成判定用 scope 内全部终态（小样阶段只看小样，全套看全部）
  const scopeTerminal = scope.length > 0 && scope.every((item) => !isTransient(item.status))
  const productionBase = (): NodeBoardStatus => {
    if (pos < 3) return "idle"
    if (busy && pendingKind === "produce_cards") return "running"
    if (!scopeTerminal) return "running" // 仍有在途卡（复述轮询期间的中断态）
    return "done"
  }
  const imagegenStatus = productionBase()
  const reviewStatus = productionBase()
  const supervisorStatus = productionBase()

  const card = (
    nodeKey: ClassicNodeKey,
    status: NodeBoardStatus,
    processed: number,
    total: number,
  ): NodeCardInfo => ({
    nodeKey,
    status: errorNode === nodeKey ? "failed" : status,
    processed,
    total,
    failedCount,
    retryCount,
    lastError,
  })

  return [
    card("style", styleStatus, pos >= 1 || run.selectedDirectionId ? 1 : run.brief ? 1 : 0, 1),
    card("structure", structureStatus, items.length, cardTotal),
    card("copywriter", copywriterStatus, withFinal, cardTotal),
    card("imagegen", imagegenStatus, withImage, scope.length),
    card("review_content", reviewStatus, withRound, scope.length),
    card("review_aesthetic", reviewStatus, withRound, scope.length),
    card("review_consistency", reviewStatus, withRound, scope.length),
    card("supervisor", supervisorStatus, withFinalRound, scope.length),
  ]
}
