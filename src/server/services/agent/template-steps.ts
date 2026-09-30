/**
 * 模板化流程步骤执行器（塔罗模板 AI Agent 流；由 agent-processor 认领触发）
 *
 * 与经典全流程编排器（agent-orchestrator）并行的一条轻量执行路径：
 * - 动作来源：agent_run.pendingAction（server actions 排队写入；worker 原子
 *   认领后调用本执行器，成功/失败后由 processor 复位为 waiting_human）；
 * - 角色编制：复用 @/lib/agent/templates 的七角色 systemPrompt，模型取
 *   agent_direction_config（direction = tarot）的 styleChatModelId（创意总监）
 *   与 structureChatModelId（世界观策划）；
 * - 留痕：assistant 消息带 meta（澄清轮次/简报/方向清单），事件 nodeKey =
 *   角色 id（creative_director / world_planner），团队面板据此推导角色状态，
 *   因此每个动作必须成对发出 start + done/fail。
 *
 * 动作语义：
 * - clarify_turn：通读全部对话历史（首条用户消息可附参考图），产出澄清分析
 *   与 ≤3 个追问；ready 或第 4 轮时在同一任务内直接续跑 finalize_brief；
 * - finalize_brief：把澄清结论整理成《设计简报》（阶段停留在 clarify）；
 * - gen_directions：依据简报（与可选反馈）产出恰好 3 个内容方向。
 */
import { asc, eq } from "drizzle-orm"
import { db } from "@/db/client"
import {
  agentDirectionConfigs,
  agentEvents,
  agentMessages,
  agentRuns,
  type AgentMessageRow,
  type AgentRunRow,
} from "@/db/schema"
import type {
  ChatContentPart,
  ChatUpstreamMessage,
} from "@/lib/ai/chat/chat-model-config"
import { signUploadToken } from "@/lib/storage/upload-token"
import { TAROT_CLARIFICATION, TAROT_ROLES } from "@/lib/agent/templates"
import { DEFAULT_DIRECTION_CONFIGS } from "@/lib/agent/pipelines"
import { AI_FRAME_PREVIEW_COUNT } from "@/lib/agent/compose"
import { runAiFrameComposition } from "./frame-steps"
import { executeTemplateProduction } from "@/server/services/agent-orchestrator"
import { parseClarifyOutput, validateDirections, MAX_CLARIFY_QUESTIONS } from "./template-parse"
import type { AgentPendingAction } from "@/lib/agent/graph"
import { callLlmJson, loadChatModel, LlmValidationError, type AgentLlmContext, type ChatModelRow } from "./llm"

// ═══════════════════════════ 入口 ═══════════════════════════

/**
 * 执行一个模板动作（pendingAction）。成功后不写 run 终态——由 processor 统一
 * 复位 waiting_human 并清空 pendingAction；失败时补 fail 事件后原样抛出。
 */
export async function executeTemplateAction(runId: string): Promise<void> {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId))
  if (!run) throw new Error("项目不存在")
  if (run.template !== "tarot") throw new Error("该项目不是塔罗模板项目")
  const action = run.pendingAction
  if (!action) throw new Error("没有待执行的模板动作")

  // 卡面生产是长时任务（78 张生图 + 三审 + 裁决），事件由生产执行器内部
  // 按节点逐条记录，不走这里的 start/done 成对包装。
  if (action.kind === "produce_cards") {
    await executeTemplateProduction({ runId: run.id })
    return
  }

  const nodeKey = ["compose_preview", "compose_batch"].includes(action.kind) ? "compositor" : action.kind === "gen_directions" ? "world_planner" : "creative_director"
  const history = await loadHistory(run.id)
  const priorRounds = history.filter((m) => m.meta?.kind === "clarify").length
  await logTemplateEvent({
    runId: run.id,
    nodeKey,
    action: "start",
    status: "ok",
    detail: startDetailOf(action, priorRounds),
  })

  try {
    const modelIds = await loadTarotModelIds()
    const ctx: AgentLlmContext = { run, chatModelCache: new Map() }
    if (action.kind === "compose_preview" || action.kind === "compose_batch") {
      await runAiFrameComposition(run, action)
    } else if (action.kind === "gen_directions") {
      if (!modelIds.structureChatModelId) throw new Error("塔罗模板未配置世界观策划模型，请联系管理员")
      const model = await loadChatModel(ctx, modelIds.structureChatModelId)
      await runGenDirections(ctx, run, model, action.feedback)
    } else {
      if (!modelIds.styleChatModelId) throw new Error("塔罗模板未配置创意总监模型，请联系管理员")
      const model = await loadChatModel(ctx, modelIds.styleChatModelId)
      if (action.kind === "finalize_brief") {
        await runFinalizeBrief(ctx, run, model, history)
      } else {
        const round = priorRounds + 1
        const ready = await runClarifyTurn(ctx, run, model, history, round)
        // 用户确认信息已足够，或追问达到配置的上限（超管可配 1-8）：
        // 同一任务内直接整理简报，省一轮往返
        if (ready || round >= modelIds.clarifyMaxRounds) {
          await runFinalizeBrief(ctx, run, model, history)
        }
      }
    }
  } catch (err) {
    await logTemplateEvent({
      runId: run.id,
      nodeKey,
      action: "fail",
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

function startDetailOf(action: AgentPendingAction, priorRounds: number): string {
  switch (action.kind) {
    case "clarify_turn":
      return `正在根据你的回答整理第 ${priorRounds + 1} 轮追问`
    case "finalize_brief":
      return "正在把澄清结论整理成《设计简报》"
    case "gen_directions":
      return action.feedback ? "正在根据你的反馈重新构思 3 个内容方向" : "正在构思 3 个内容方向"
    case "compose_preview":
      return `正在生成 ${AI_FRAME_PREVIEW_COUNT} 张 AI 融合预览`
    case "compose_batch":
      return action.itemId ? "正在重做一张 AI 融合卡面" : "正在批量 AI 融合 78 张卡面"
    case "produce_cards":
      return action.phase === "full" ? "正在全套生产 78 张卡面" : "正在生成风格小样"
  }
}

// ═══════════════════════════ 公共小件 ═══════════════════════════

async function loadHistory(runId: string): Promise<AgentMessageRow[]> {
  return db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.runId, runId))
    .orderBy(asc(agentMessages.createdAt))
}

/** 模板角色模型取自 agent_direction_config（direction = tarot），缺行回退内置默认 */
async function loadTarotModelIds(): Promise<{ styleChatModelId: string | null; structureChatModelId: string | null; clarifyMaxRounds: number }> {
  const [row] = await db
    .select()
    .from(agentDirectionConfigs)
    .where(eq(agentDirectionConfigs.direction, "tarot"))
  const fallback = DEFAULT_DIRECTION_CONFIGS.find((item) => item.direction === "tarot")!
  const models =
    row?.models ?? fallback.models
  // 澄清追问轮数上限跟随模板配置（超管可配 1-8）；缺行/缺列/非法值回退 4
  const templateConfig = (row?.templateConfig ?? null) as { clarifyMaxRounds?: unknown } | null
  const rawRounds = templateConfig?.clarifyMaxRounds
  const clarifyMaxRounds =
    typeof rawRounds === "number" && Number.isInteger(rawRounds) && rawRounds >= 1 && rawRounds <= 8 ? rawRounds : 4
  return {
    styleChatModelId: models.styleChatModelId ?? null,
    structureChatModelId: models.structureChatModelId ?? null,
    clarifyMaxRounds,
  }
}

async function logTemplateEvent(input: {
  runId: string
  nodeKey: string
  action: string
  status: "ok" | "warn" | "error"
  detail: string
}): Promise<void> {
  await db.insert(agentEvents).values({
    runId: input.runId,
    nodeKey: input.nodeKey,
    nodeType: "agent",
    action: input.action,
    status: input.status,
    detail: input.detail,
  })
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * 对话历史 → 上游消息（user/assistant）。参考图只附在首条用户消息上，
 * 且仅当模型支持视觉；不支持时忽略图片并发 warn 事件（仅文本澄清）。
 */
function toUpstreamMessages(input: {
  history: AgentMessageRow[]
  referenceImages: string[]
  supportsVision: boolean
}): { messages: ChatUpstreamMessage[]; skippedImageCount: number } {
  let firstUserSeen = false
  let skippedImageCount = 0
  const messages: ChatUpstreamMessage[] = []
  for (const m of input.history) {
    if (m.role !== "user" && m.role !== "assistant") continue
    if (m.role === "user" && !firstUserSeen) {
      firstUserSeen = true
      if (input.referenceImages.length > 0) {
        if (!input.supportsVision) {
          skippedImageCount = input.referenceImages.length
        } else {
          const parts: ChatContentPart[] = [
            { type: "text", text: m.content },
            ...input.referenceImages.map((url) => ({
              type: "image_url" as const,
              image_url: { url: signUploadToken(url) },
            })),
          ]
          messages.push({ role: "user", content: parts })
          continue
        }
      }
    }
    messages.push({ role: m.role, content: m.content })
  }
  return { messages, skippedImageCount }
}

// 澄清/方向输出解析与校验（纯函数）已抽至 ./template-parse（斩断测试的 redis import 链）

// ═══════════════════════════ 步骤实现 ═══════════════════════════

/** 澄清清单紧凑序列化（写进创意总监 system prompt 作为核对底稿） */
function serializeClarification(): string {
  return TAROT_CLARIFICATION.map((section) =>
    [
      `【${section.title}】`,
      ...section.questions.map(
        (q) =>
          `- ${q.id}｜${q.question}${q.required ? "（必答）" : "（选答）"}` +
          `${q.options.length ? `｜可选：${q.options.join(" / ")}` : ""}｜未答默认：${q.fallback}`,
      ),
    ].join("\n"),
  ).join("\n")
}

function rolePrompt(roleId: string): string {
  const role = TAROT_ROLES.find((r) => r.id === roleId)
  if (!role) throw new Error(`模板角色未注册：${roleId}`)
  return role.systemPrompt
}

/** 澄清轮：通读历史 → 追问 ≤3 条或宣布就绪；返回是否 ready */
async function runClarifyTurn(
  ctx: AgentLlmContext,
  run: AgentRunRow,
  model: ChatModelRow,
  history: AgentMessageRow[],
  round: number,
): Promise<boolean> {
  const referenceImages = Array.isArray(run.input.referenceImages)
    ? run.input.referenceImages.slice(0, 4)
    : []
  const { messages, skippedImageCount } = toUpstreamMessages({
    history,
    referenceImages,
    supportsVision: model.supportsVision,
  })
  if (skippedImageCount > 0) {
    await logTemplateEvent({
      runId: run.id,
      nodeKey: "creative_director",
      action: "fail",
      status: "warn",
      detail: `当前模型不支持读图，${skippedImageCount} 张参考图未纳入本轮澄清（仅按文本分析）`,
    })
  }

  const systemPrompt = [
    rolePrompt("creative_director"),
    "当前任务：主持需求澄清对话。请通读全部历史消息（用户最初的主题描述与后续回答），结合参考图（如有），判断信息是否足以开始创作。",
    "参考澄清清单（逐条核对你已掌握的信息，只有尚未明确且影响创作决策的点才需要追问）：",
    serializeClarification(),
    "【输出格式】只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：",
    '{ "analysis": "对已明确需求与仍缺失信息的简要分析（中文 2-4 句）", "filled": { "清单问题id": "已确认的结论或采用的默认取向" }, "questions": [ { "id": "问题id（沿用清单 id 或自拟）", "question": "要问用户的问题（中文，具体不空泛）", "options": ["快捷选项"] } ], "ready": true|false }',
    `约束：questions 最多 ${MAX_CLARIFY_QUESTIONS} 个（信息足够时给空数组），每个问题 2-4 个选项；不要重复问用户已经回答过的问题；信息已足够时 ready = true。`,
  ].join("\n\n")

  const parsed = await callLlmJson<Record<string, unknown>>(ctx, model, {
    systemPrompt,
    messages,
    thinkingLevel: "medium",
    validate: (raw) => {
      parseClarifyOutput(raw)
    },
  })
  const clarify = parseClarifyOutput(parsed)

  const replyLines: string[] = []
  if (clarify.analysis) replyLines.push(clarify.analysis)
  if (clarify.questions.length > 0) {
    replyLines.push("", "为了更贴近你的想法，想请你确认：")
    clarify.questions.forEach((q, i) => {
      replyLines.push(`${i + 1}. ${q.question}`)
      if (q.options.length > 0) replyLines.push(`   可选：${q.options.join(" / ")}`)
    })
  }
  replyLines.push(
    "",
    clarify.ready
      ? "需求已经比较清晰了，我正在把我们的讨论整理成《设计简报》。"
      : "也可以直接点击「生成创作简报」，我会按已有信息与默认取向整理。",
  )

  await db.insert(agentMessages).values({
    runId: run.id,
    role: "assistant",
    content: replyLines.join("\n").trim(),
    nodeKey: "creative_director",
    meta: {
      kind: "clarify",
      round,
      analysis: clarify.analysis || undefined,
      questions: clarify.questions,
      ready: clarify.ready,
    },
  })
  await logTemplateEvent({
    runId: run.id,
    nodeKey: "creative_director",
    action: "done",
    status: "ok",
    detail: clarify.ready
      ? "需求已明确，正在整理创作简报"
      : `已提出 ${clarify.questions.length} 个澄清问题`,
  })
  return clarify.ready
}

/** 简报整理：把澄清结论结构化为《设计简报》（阶段停留在 clarify，等用户确认） */
async function runFinalizeBrief(
  ctx: AgentLlmContext,
  run: AgentRunRow,
  model: ChatModelRow,
  history: AgentMessageRow[],
): Promise<void> {
  const { messages } = toUpstreamMessages({ history, referenceImages: [], supportsVision: false })
  const systemPrompt = [
    rolePrompt("creative_director"),
    "当前任务：把需求澄清对话的全部结论整理成一份《设计简报》，供后续世界观策划、提示词设计与审核直接引用。",
    "简报用中文书写，按以下小节组织（小节标题用「##」）：",
    "## 主题与世界观\n## 艺术风格与媒介\n## 色调\n## 氛围\n## 目标用途\n## 象征体系\n## 禁忌元素\n## 参考图解读",
    "要求：每节内容具体可执行，直接采用用户已确认的答案；用户未答复的小节按澄清清单的默认取向补全并注明「（默认取向）」；没有参考图时「参考图解读」写「无」。篇幅控制在 800 字以内。",
    "【输出格式】只输出一个 JSON 对象：{ \"brief\": \"完整简报正文（Markdown 纯文本）\" }，不要输出 JSON 以外的任何内容。",
  ].join("\n\n")

  const parsed = await callLlmJson<{ brief?: unknown }>(ctx, model, {
    systemPrompt,
    messages,
    thinkingLevel: "medium",
    validate: (raw) => {
      const brief = asRecord(raw)?.brief
      if (typeof brief !== "string" || !brief.trim()) {
        throw new LlmValidationError("缺少 brief 字段或内容为空")
      }
    },
  })
  const brief = typeof parsed.brief === "string" ? parsed.brief.trim() : ""

  await db
    .update(agentRuns)
    .set({ brief, updatedAt: new Date() })
    .where(eq(agentRuns.id, run.id))
  await db.insert(agentMessages).values({
    runId: run.id,
    role: "assistant",
    content: `《设计简报》已生成，请查看并确认：\n\n${brief}`,
    nodeKey: "creative_director",
    meta: { kind: "brief" },
  })
  await logTemplateEvent({
    runId: run.id,
    nodeKey: "creative_director",
    action: "done",
    status: "ok",
    detail: "《设计简报》已生成，请确认或修改后进入内容方向阶段",
  })
}

/** 内容方向：依据简报（与可选反馈）产出恰好 3 个方向，写入 run.directions */
async function runGenDirections(
  ctx: AgentLlmContext,
  run: AgentRunRow,
  model: ChatModelRow,
  feedback?: string,
): Promise<void> {
  const previousNames = Array.isArray(run.directions)
    ? run.directions.map((d) => d.name).filter(Boolean)
    : []
  const requestLines: string[] = [
    run.brief ? `【创作简报】\n${run.brief}` : `【创作简报】\n（用户未生成简报，原始需求：${run.input.prompt}）`,
  ]
  if (feedback) requestLines.push(`【用户反馈】请围绕以下意见调整方向：${feedback}`)
  if (previousNames.length > 0) {
    requestLines.push(`【已出现过的方向名（必须避开，也不要换皮重现）】${previousNames.join("、")}`)
  }
  requestLines.push("请输出 3 个新的内容方向。")

  const systemPrompt = [
    rolePrompt("world_planner"),
    "当前任务：依据《创作简报》构思 3 个彼此差异明显、各自成体系的内容方向，供用户选择。每个方向都要能支撑完整 78 张塔罗的世界观与视觉语言。",
    "【输出格式】只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：",
    '{ "directions": [ { "id": "英文短横线标识（slug）", "name": "方向名（中文 3-6 字）", "concept": "一句话概念", "description": "2-3 句说明（核心意象与情绪）", "worldview": "世界观概述（2-4 句）", "majorArcana": "大阿卡纳的演绎思路（1-2 句）", "suitMapping": [ { "suit": "权杖", "mapping": "该方向下权杖花色的意象映射" }, { "suit": "圣杯", "mapping": "…" }, { "suit": "宝剑", "mapping": "…" }, { "suit": "星币", "mapping": "…" } ], "palette": "主辅色描述", "visualLanguage": "视觉语言：媒介、质感、构图与装饰特征（2-3 句）", "sampleCards": [ { "name": "牌名（如 愚者）", "scene": "该方向下这张牌的画面场景（1-2 句）" }, { "name": "…", "scene": "…" }, { "name": "…", "scene": "…" } ] }, { … }, { … } ] }',
    "约束：恰好 3 个方向；方向名互不重复；suitMapping 必须覆盖 权杖/圣杯/宝剑/星币 四花色；sampleCards 恰好 3 张（建议从 愚者/女祭司/恋人/命运之轮/月亮/世界 中选取）。",
  ].join("\n\n")

  const parsed = await callLlmJson<Record<string, unknown>>(ctx, model, {
    systemPrompt,
    messages: [{ role: "user", content: requestLines.join("\n\n") }],
    thinkingLevel: "medium",
    validate: (raw) => {
      validateDirections(raw)
    },
  })
  const directions = validateDirections(parsed)

  await db
    .update(agentRuns)
    .set({ directions, selectedDirectionId: null, updatedAt: new Date() })
    .where(eq(agentRuns.id, run.id))
  await db.insert(agentMessages).values({
    runId: run.id,
    role: "assistant",
    content: [
      `已生成 ${directions.length} 个内容方向：`,
      ...directions.map((d) => `· ${d.name}：${d.concept || d.description}`),
      "",
      "请选择其中一个方向继续，或告诉我要调整的地方（我会重新构思）。",
    ].join("\n"),
    nodeKey: "world_planner",
    meta: { kind: "directions", count: directions.length },
  })
  await logTemplateEvent({
    runId: run.id,
    nodeKey: "world_planner",
    action: "done",
    status: "ok",
    detail: `已生成 ${directions.length} 个内容方向：${directions.map((d) => d.name).join(" / ")}`,
  })
}
