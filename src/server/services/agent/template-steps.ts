/**
 * 模板化流程步骤执行器（塔罗模板 AI Agent 流；由 agent-processor 认领触发）
 *
 * 与经典全流程编排器（agent-orchestrator）并行的一条轻量执行路径：
 * - 动作来源：agent_run.pendingAction（server actions 排队写入；worker 原子
 *   认领后调用本执行器，成功/失败后由 processor 复位为 waiting_human）；
 * - 角色编制：复用 @/lib/agent/templates 的八角色 systemPrompt，模型取
 *   agent_direction_config（direction = tarot）的 styleChatModelId（创意总监）
 *   与 structureChatModelId（风格策划）；
 * - 留痕：assistant 消息带 meta（澄清轮次/简报/风格规范书），事件 nodeKey =
 *   角色 id（creative_director / style_director），团队面板据此推导角色状态，
 *   因此每个动作必须成对发出 start + done/fail。
 *
 * 动作语义（新五阶段）：
 * - clarify_turn：通读全部对话历史（首条用户消息可附参考图），只围绕
 *   风格/内容/主题/画面内容追问 ≤3 条；ready 或达轮数上限时在同一任务内
 *   直接续跑 finalize_brief；
 * - finalize_brief：把澄清结论整理成《设计简报》（阶段停留在 clarify）；
 * - gen_style_spec：依据简报产出 3 个候选《风格规范书》（含画面风格总述）
 *   供用户选择，选定前不创建卡牌清单、不撰写初稿；
 * - design_drafts：用户选定方向后批量撰写 78 张画面提示词初稿（简洁明了，
 *   用户可编辑）；
 * - design_finals：批量把初稿细化为结构化终稿（[1]画面风格 + [2]画面内容）。
 *
 * 旧动作（存量 run 过渡期保留）：gen_directions / design_prompts。
 */
import { asc, eq } from "drizzle-orm"
import { db } from "@/db/client"
import {
  agentDirectionConfigs,
  agentEvents,
  agentMessages,
  agentRunItems,
  agentRuns,
  type AgentMessageRow,
  type AgentRunRow,
} from "@/db/schema"
import type {
  ChatContentPart,
  ChatUpstreamMessage,
} from "@/lib/ai/chat/chat-model-config"
import { signUploadToken } from "@/lib/storage/upload-token"
import {
  SUIT_COUNT_RULE_SUMMARY,
  TAROT_CLARIFICATION,
  TAROT_CARDS,
  TAROT_ROLES,
  suitCountRuleByIndex,
} from "@/lib/agent/templates"
import {
  composeFinalRefinerPrompt,
  composePromptDesignerPrompt,
  DEFAULT_DIRECTION_CONFIGS,
  resolveCardImageSize,
  type DirectionConfig,
} from "@/lib/agent/pipelines"
import {
  composeDraftPrompt,
  DRAFT_PROMPT_MIN_CHARS,
  fallbackCardBody,
  fallbackFinalPrompt,
  FINAL_CONTENT_MIN_CHARS,
  normalizeFinalPrompt,
  splitFinalPromptSegments,
} from "@/lib/agent/cards/plan"
import { AI_FRAME_PREVIEW_COUNT } from "@/lib/agent/compose"
import { orientationOfCardSize } from "@/lib/agent/asset-prompts"
import { runAiFrameComposition } from "./frame-steps"
import { runTarotAssetGeneration } from "./asset-steps"
import { executeTemplateProduction } from "@/server/services/agent-orchestrator"
import {
  parseClarifyOutput,
  validateDirections,
  validateStyleDirections,
  MAX_CLARIFY_OPTIONS,
  MAX_CLARIFY_QUESTIONS,
} from "./template-parse"
import { loadFullDirectionConfig } from "./direction-config"
import { env } from "@/lib/env"
import type { AgentNodeType, AgentPendingAction } from "@/lib/agent/graph"
import { resolveAgentLlmSlotLimit } from "./llm-slots"
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
  // 按节点逐条记录，不走这里的 start/done 成对包装；但整体异常时仍兜底补
  // fail 事件（与下方短任务 catch 同语义），避免只落 run.error 而时间线无痕。
  // nodeKey 与步骤内部事件对齐（团队面板按 roleId 归组，落在无人认领的
  // 节点 id 上会让错误不归属任何角色）。
  const longRunningRunners: Partial<Record<string, { nodeKey: string; nodeType: AgentNodeType; run: () => Promise<void> }>> = {
    produce_cards: { nodeKey: "artist", nodeType: "agent", run: () => executeTemplateProduction({ runId: run.id }) },
    asset_gen: { nodeKey: "compositor", nodeType: "agent", run: () => runTarotAssetGeneration(run, action) },
    design_drafts: { nodeKey: "prompt_designer", nodeType: "agent", run: () => runDesignDrafts(run, action) },
    design_prompts: { nodeKey: "prompt_designer", nodeType: "agent", run: () => runDesignDrafts(run, action) },
    design_finals: { nodeKey: "final_refiner", nodeType: "agent", run: () => runDesignFinals(run, action) },
  }
  const longRunner = longRunningRunners[action.kind]
  if (longRunner) {
    try {
      await longRunner.run()
    } catch (err) {
      await logTemplateEvent({
        runId: run.id,
        nodeKey: longRunner.nodeKey,
        nodeType: longRunner.nodeType,
        action: "fail",
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
    return
  }

  const nodeKey = ["compose_preview", "compose_batch"].includes(action.kind)
    ? "compositor"
    : action.kind === "gen_style_spec" || action.kind === "gen_directions"
      ? "style_director"
      : "creative_director"
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
    } else if (action.kind === "gen_style_spec") {
      // 风格策划模型缺配时回退创意总监模型（澄清已可用 → 该槽位必然有效），
      // 避免用户因后台少配一个槽位而永久卡在「等待候选方向」
      const specModelId = modelIds.structureChatModelId ?? modelIds.styleChatModelId
      if (!specModelId) {
        throw new Error("塔罗模板未配置风格策划/创意总监模型，请联系管理员在「Agent 工坊配置」中补齐")
      }
      const model = await loadChatModel(ctx, specModelId)
      // 产出 3 个候选《风格规范书》后停下等用户选择（选定动作由
      // selectTemplateDirectionAction 排队 design_drafts，选定前不写初稿）
      await runGenStyleDirections(ctx, run, model, action.feedback)
    } else if (action.kind === "gen_directions") {
      // 旧流程（存量 run 过渡期）：三方向生成（同样回退创意总监模型）
      const plannerModelId = modelIds.structureChatModelId ?? modelIds.styleChatModelId
      if (!plannerModelId) {
        throw new Error("塔罗模板未配置风格策划/创意总监模型，请联系管理员在「Agent 工坊配置」中补齐")
      }
      const model = await loadChatModel(ctx, plannerModelId)
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
    case "gen_style_spec":
      return action.feedback ? "正在根据你的反馈重新拟定 3 个风格规范方向" : "正在拟定 3 个《风格规范书》候选方向"
    case "gen_directions":
      return action.feedback ? "正在根据你的反馈重新构思 3 个内容方向" : "正在构思 3 个内容方向"
    case "design_drafts":
      return action.itemIds?.length
        ? `正在重新撰写 ${action.itemIds.length} 张画面提示词初稿`
        : "正在撰写 78 张画面提示词初稿"
    case "design_finals":
      return action.itemIds?.length
        ? `正在重新细化 ${action.itemIds.length} 张终稿`
        : "正在把 78 张初稿细化为结构化终稿"
    case "design_prompts":
      return action.itemIds?.length
        ? `正在重新撰写 ${action.itemIds.length} 张卡面提示词`
        : "正在撰写 78 张卡面提示词"
    case "compose_preview":
      return `正在生成 ${AI_FRAME_PREVIEW_COUNT} 张 AI 融合预览`
    case "compose_batch":
      return action.itemId ? "正在重做一张 AI 融合卡面" : "正在批量 AI 融合 78 张卡面"
    case "produce_cards":
      return action.phase === "full" ? "正在全套生产 78 张卡面" : "正在生成风格小样"
    case "asset_gen":
      return `正在生成 ${action.assetTasks?.length ?? 0} 项周边资产`
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
  nodeType?: AgentNodeType
  action: string
  status: "ok" | "warn" | "error"
  detail: string
}): Promise<void> {
  await db.insert(agentEvents).values({
    runId: input.runId,
    nodeKey: input.nodeKey,
    nodeType: input.nodeType ?? "agent",
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

// ═══════════════════════════ 初稿撰写（design_drafts） ═══════════════════════════

/** design_drafts / design_finals 每批张数（78 张 ≈ 10 批） */
const PROMPT_BATCH_SIZE = 8

/**
 * 批间并发：按对话三层槽位（模型/权限组/企业 chat）上限拉满——每个批
 * 就是一次 LLM 调用，多余在途请求只会在槽位前排队，不会突破上游限流。
 * 三层全不限或超出环境变量时以 AGENT_PROMPT_BATCH_CONCURRENCY 为准
 * （绝对上限保护），且不超过批数。
 */
export async function resolvePromptBatchConcurrency(
  ctx: AgentLlmContext,
  model: ChatModelRow,
  batchCount: number,
): Promise<number> {
  const cap = env.AGENT_PROMPT_BATCH_CONCURRENCY
  const slotLimit = await resolveAgentLlmSlotLimit(ctx, model)
  return Math.max(1, Math.min(slotLimit ?? cap, cap, Math.max(1, batchCount)))
}

type PromptTargetItem = typeof agentRunItems.$inferSelect

/** LLM 输出的单卡结构（宽松收窄：字段类型在使用处再判） */
type LlmCard = { index?: unknown; meaning?: unknown; visualBrief?: unknown; finalPrompt?: unknown }

function designDraftsSystemPrompt(config: DirectionConfig): string {
  return [
    composePromptDesignerPrompt(config),
    SUIT_COUNT_RULE_SUMMARY,
    "当前任务：为用户给出的每张塔罗牌撰写画面提示词初稿。初稿简洁明了（40-80 字）：一句话点明唯一主体，一句话交代场景与氛围；不拼接任何风格前缀、不写任何负向约束；不得描述沿画面边缘连续分布的纹样、线条或色带等类似边框的装饰。",
    "【输出格式】只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：",
    '{ "cards": [ { "index": 卡牌序号（整数，与输入一致）, "meaning": "一句话牌义（可润色，保持原意）", "visualBrief": "画面提示词初稿（40-80 字）" } ] }',
    `cards 数组必须与输入卡牌一一对应（数量相同、index 一致）；每条 visualBrief 不少于 ${DRAFT_PROMPT_MIN_CHARS} 字且符合画面规则与花色数量规则。`,
  ].join("\n\n")
}

/** 单卡初稿写回：visualBrief=初稿、currentPrompt=初稿直通（无前缀无负向），来源留痕 */
async function writeCardDraft(
  item: PromptTargetItem,
  output: { meaning: string; body: string; source: "ai" | "initial" },
): Promise<void> {
  await db
    .update(agentRunItems)
    .set({
      meaning: output.meaning,
      visualBrief: output.body,
      currentPrompt: composeDraftPrompt(output.body),
      promptSource: output.source,
      updatedAt: new Date(),
    })
    .where(eq(agentRunItems.id, item.id))
}

/**
 * 初稿设计阶段：由初稿设计师（LLM）分批撰写逐卡画面提示词初稿。
 * design_prompts（存量 run 旧动作）也走本执行器——旧项目重生成时同样
 * 产出新流程口径的初稿，用户在终稿阶段确认或重细化后进入生产。
 * 批失败或输出不合格的卡回退确定性模板并标 warn，用户可在清单页单张重生成。
 */
async function runDesignDrafts(run: AgentRunRow, action: AgentPendingAction): Promise<void> {
  const nodeKey = "prompt_designer"
  const ctx: AgentLlmContext = { run, chatModelCache: new Map() }
  try {
    const config = await loadFullDirectionConfig("tarot")
    const modelId = config.templateConfig?.copywriterChatModelId ?? config.models.copywriterChatModelId
    if (!modelId) {
      throw new Error("塔罗模板未配置文案改写模型（初稿设计师），请联系管理员在「Agent 工坊配置」中补齐")
    }
    const model = await loadChatModel(ctx, modelId)
    const direction = (run.directions ?? []).find((item) => item.id === run.selectedDirectionId) ?? null
    if (!direction) throw new Error("风格规范书未定稿，无法撰写初稿")

    const allItems = await db
      .select()
      .from(agentRunItems)
      .where(eq(agentRunItems.runId, run.id))
      .orderBy(asc(agentRunItems.index))
    const targetIds = action.itemIds?.length ? new Set(action.itemIds) : null
    const targets = targetIds ? allItems.filter((item) => targetIds.has(item.id)) : allItems
    if (targets.length === 0) throw new Error("没有待撰写初稿的卡牌")

    await logTemplateEvent({
      runId: run.id,
      nodeKey,
      action: "start",
      status: "ok",
      detail: action.feedback
        ? `初稿设计师开始按反馈重写 ${targets.length} 张画面初稿`
        : `初稿设计师开始撰写 ${targets.length} 张画面初稿（简洁明了，可在下页逐张编辑）`,
    })

    const directionBrief = [
      `【风格规范书】${direction.name}`,
      direction.visualLanguage,
      direction.worldview ? `【世界观】${direction.worldview}` : "",
      direction.palette ? `【色彩基调】${direction.palette}` : "",
      run.brief ? `【设计简报】${run.brief.slice(0, 1500)}` : "",
    ]
      .filter(Boolean)
      .join("\n")

    const hintByIndex = new Map(TAROT_CARDS.map((card) => [card.index, card.hint]))
    const fallbackFor = (item: PromptTargetItem) =>
      fallbackCardBody({ name: item.name ?? "", hint: hintByIndex.get(item.index) ?? "牌义意象" })

    let aiCount = 0
    let fallbackCount = 0
    let doneCount = 0

    const batches: PromptTargetItem[][] = []
    for (let i = 0; i < targets.length; i += PROMPT_BATCH_SIZE) {
      batches.push(targets.slice(i, i + PROMPT_BATCH_SIZE))
    }

    const runBatch = async (batch: PromptTargetItem[]) => {
      const writeFallbackBatch = async (reason: string) => {
        for (const item of batch) {
          await writeCardDraft(item, { meaning: item.meaning ?? "", body: fallbackFor(item), source: "initial" })
          fallbackCount += 1
        }
        await logTemplateEvent({
          runId: run.id,
          nodeKey,
          action: "fail",
          status: "warn",
          detail: `第 ${batch[0]!.index + 1}-${batch[batch.length - 1]!.index + 1} 张 AI 撰写失败，已用模板兜底（${reason}），可稍后单张重新生成`,
        })
      }

      try {
        const parsed = await callLlmJson<{ cards?: unknown }>(ctx, model, {
          systemPrompt: designDraftsSystemPrompt(config),
          messages: [
            {
              role: "user",
              content: [
                directionBrief,
                "",
                action.feedback
                  ? `【用户反馈】${action.feedback.slice(0, 500)}\n\n请按反馈重新撰写以下卡牌：`
                  : "请为以下卡牌逐张撰写初稿：",
                JSON.stringify(
                  batch.map((item) => ({
                    index: item.index,
                    name: item.name,
                    hint: hintByIndex.get(item.index) ?? "",
                    meaning: item.meaning ?? "",
                    suitRule: suitCountRuleByIndex(item.index),
                  })),
                ),
              ].join("\n"),
            },
          ],
          thinkingLevel: config.models.copywriterThinkingLevel,
          validate: (raw) => {
            if (!Array.isArray(raw.cards) || raw.cards.length !== batch.length) {
              throw new LlmValidationError(`cards 数组长度应为 ${batch.length}，与输入卡牌一致`)
            }
          },
        })

        // 输出按 index 对齐；缺正文/过短/张冠李戴的卡逐张兜底，其余照常写回
        const byIndex = new Map<number, LlmCard>()
        for (const card of (parsed.cards ?? []) as LlmCard[]) {
          if (card && typeof card === "object" && typeof card.index === "number") {
            byIndex.set(card.index, card)
          }
        }
        let shortCount = 0
        for (const item of batch) {
          const out = byIndex.get(item.index)
          const body = typeof out?.visualBrief === "string" ? out.visualBrief.trim() : ""
          const meaning =
            typeof out?.meaning === "string" && out.meaning.trim() ? out.meaning.trim() : item.meaning ?? ""
          if (body.length >= DRAFT_PROMPT_MIN_CHARS) {
            await writeCardDraft(item, { meaning, body, source: "ai" })
            aiCount += 1
          } else {
            await writeCardDraft(item, { meaning, body: fallbackFor(item), source: "initial" })
            fallbackCount += 1
            shortCount += 1
          }
        }
        if (shortCount > 0) {
          await logTemplateEvent({
            runId: run.id,
            nodeKey,
            action: "fail",
            status: "warn",
            detail: `本批 ${shortCount} 张初稿缺失或过短，已用模板兜底，可单张重新生成`,
          })
        }
      } catch (err) {
        await writeFallbackBatch(err instanceof Error ? err.message : String(err))
      } finally {
        doneCount += batch.length
        await logTemplateEvent({
          runId: run.id,
          nodeKey,
          action: "start",
          status: "ok",
          detail: `画面初稿撰写进度：${doneCount}/${targets.length} 张（AI 撰写 ${aiCount}，模板兜底 ${fallbackCount}）`,
        })
      }
    }

    // 并发池：批并发按对话三层槽位上限拉满（见 resolvePromptBatchConcurrency）
    const batchConcurrency = await resolvePromptBatchConcurrency(ctx, model, batches.length)
    let cursor = 0
    const workers = Array.from(
      { length: batchConcurrency },
      async () => {
        while (cursor < batches.length) {
          const batch = batches[cursor]!
          cursor += 1
          await runBatch(batch)
        }
      },
    )
    await Promise.all(workers)

    await logTemplateEvent({
      runId: run.id,
      nodeKey,
      action: "done",
      status: "ok",
      detail:
        `画面初稿撰写完成：AI 撰写 ${aiCount} 张` +
        (fallbackCount > 0 ? `，模板兜底 ${fallbackCount} 张（可单张重新生成）` : "") +
        "，请在初稿页逐张查看、修改后确认进入终稿细化",
    })
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

// ═══════════════════════════ 终稿细化（design_finals） ═══════════════════════════

function designFinalsSystemPrompt(config: DirectionConfig, styleSummary: string, cardOrientation: string): string {
  return [
    composeFinalRefinerPrompt(config),
    SUIT_COUNT_RULE_SUMMARY,
    "当前任务：把给定的每张画面提示词初稿细化为结构化终稿。终稿为一段完整文本，必须严格按以下两段结构组织：",
    `${"[1] 画面风格："}${styleSummary}（此段整套逐字一致，直接复制给定内容，不得改写）`,
    `[2] 画面内容：（在初稿基础上细化为 150-250 字：主体外观细节、动作姿态、服饰道具、环境背景、光影与色彩对比；主体占画面 60% 以上、近景特写、${cardOrientation}构图，构图比例与卡面出图尺寸一致）`,
    "【输出格式】只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：",
    '{ "cards": [ { "index": 卡牌序号（整数，与输入一致）, "finalPrompt": "[1] 画面风格：…\\n[2] 画面内容：…" } ] }',
    `cards 数组必须与输入卡牌一一对应（数量相同、index 一致）；每条 finalPrompt 的[画面内容]段不少于 ${FINAL_CONTENT_MIN_CHARS} 字，并以「画面边缘为干净的满幅构图，无任何边框或边缘装饰」结尾（无边框硬规则，唯一允许的禁止性表述）；除此之外不得含其他负向约束或「不要出现××」类表述。`,
  ].join("\n\n")
}

/**
 * 终稿细化阶段：由终稿细化师（LLM）分批把初稿细化为结构化终稿
 * （[1]画面风格 + [2]画面内容），写入 currentPrompt（promptSource="final"）。
 * 风格段整套统一（取风格规范书总述）；批失败或结构不合格的卡回退
 * 确定性兜底终稿并标 warn，用户可在终稿页单张重细化。
 */
async function runDesignFinals(run: AgentRunRow, action: AgentPendingAction): Promise<void> {
  const nodeKey = "final_refiner"
  const ctx: AgentLlmContext = { run, chatModelCache: new Map() }
  try {
    const config = await loadFullDirectionConfig("tarot")
    const modelId = config.templateConfig?.copywriterChatModelId ?? config.models.copywriterChatModelId
    if (!modelId) {
      throw new Error("塔罗模板未配置终稿细化模型，请联系管理员在「Agent 工坊配置」中补齐")
    }
    const model = await loadChatModel(ctx, modelId)
    const direction = (run.directions ?? []).find((item) => item.id === run.selectedDirectionId) ?? null
    if (!direction) throw new Error("风格规范书未定稿，无法细化终稿")

    const styleSummary = direction.visualLanguage || direction.palette || "统一的塔罗牌视觉风格"

    const allItems = await db
      .select()
      .from(agentRunItems)
      .where(eq(agentRunItems.runId, run.id))
      .orderBy(asc(agentRunItems.index))
    const targetIds = action.itemIds?.length ? new Set(action.itemIds) : null
    const targets = targetIds ? allItems.filter((item) => targetIds.has(item.id)) : allItems
    if (targets.length === 0) throw new Error("没有待细化终稿的卡牌")

    await logTemplateEvent({
      runId: run.id,
      nodeKey,
      action: "start",
      status: "ok",
      detail: action.feedback
        ? `终稿细化师开始按反馈重新细化 ${targets.length} 张终稿`
        : `终稿细化师开始把 ${targets.length} 张初稿细化为结构化终稿（[1]画面风格 + [2]画面内容）`,
    })

    const hintByIndex = new Map(TAROT_CARDS.map((card) => [card.index, card.hint]))
    const fallbackFor = (item: PromptTargetItem) =>
      fallbackFinalPrompt(
        { name: item.name ?? "", hint: hintByIndex.get(item.index) ?? "牌义意象" },
        styleSummary,
      )

    let aiCount = 0
    let fallbackCount = 0
    let doneCount = 0

    const batches: PromptTargetItem[][] = []
    for (let i = 0; i < targets.length; i += PROMPT_BATCH_SIZE) {
      batches.push(targets.slice(i, i + PROMPT_BATCH_SIZE))
    }

    const runBatch = async (batch: PromptTargetItem[]) => {
      const writeFallbackBatch = async (reason: string) => {
        for (const item of batch) {
          await db
            .update(agentRunItems)
            .set({ currentPrompt: fallbackFor(item), promptSource: "initial", updatedAt: new Date() })
            .where(eq(agentRunItems.id, item.id))
          fallbackCount += 1
        }
        await logTemplateEvent({
          runId: run.id,
          nodeKey,
          action: "fail",
          status: "warn",
          detail: `第 ${batch[0]!.index + 1}-${batch[batch.length - 1]!.index + 1} 张 AI 细化失败，已用兜底终稿（${reason}），可稍后单张重细化`,
        })
      }

      try {
        const parsed = await callLlmJson<{ cards?: unknown }>(ctx, model, {
          systemPrompt: designFinalsSystemPrompt(
            config,
            styleSummary,
            // 构图措辞与卡面出图比例一致（快照优先，管理员改配置不影响在途项目）
            orientationOfCardSize(resolveCardImageSize(run, config)),
          ),
          messages: [
            {
              role: "user",
              content: [
                action.feedback
                  ? `【用户反馈】${action.feedback.slice(0, 500)}\n\n请按反馈重新细化以下卡牌：`
                  : "请把以下卡牌的初稿逐张细化为结构化终稿：",
                JSON.stringify(
                  batch.map((item) => ({
                    index: item.index,
                    name: item.name,
                    meaning: item.meaning ?? "",
                    draft: item.visualBrief ?? "",
                    suitRule: suitCountRuleByIndex(item.index),
                  })),
                ),
              ].join("\n"),
            },
          ],
          thinkingLevel: config.models.copywriterThinkingLevel,
          validate: (raw) => {
            if (!Array.isArray(raw.cards) || raw.cards.length !== batch.length) {
              throw new LlmValidationError(`cards 数组长度应为 ${batch.length}，与输入卡牌一致`)
            }
          },
        })

        const byIndex = new Map<number, LlmCard>()
        for (const card of (parsed.cards ?? []) as LlmCard[]) {
          if (card && typeof card === "object" && typeof card.index === "number") {
            byIndex.set(card.index, card)
          }
        }
        let shortCount = 0
        for (const item of batch) {
          const out = byIndex.get(item.index)
          const raw = typeof out?.finalPrompt === "string" ? out.finalPrompt.trim() : ""
          // 结构归一化：缺两段标记时包一层（风格段取规范书总述）
          const finalPrompt = raw ? normalizeFinalPrompt(raw, styleSummary) : ""
          const segments = finalPrompt ? splitFinalPromptSegments(finalPrompt) : null
          if (segments && segments.content.length >= FINAL_CONTENT_MIN_CHARS) {
            await db
              .update(agentRunItems)
              .set({ currentPrompt: finalPrompt, promptSource: "final", updatedAt: new Date() })
              .where(eq(agentRunItems.id, item.id))
            aiCount += 1
          } else {
            await db
              .update(agentRunItems)
              .set({ currentPrompt: fallbackFor(item), promptSource: "initial", updatedAt: new Date() })
              .where(eq(agentRunItems.id, item.id))
            fallbackCount += 1
            shortCount += 1
          }
        }
        if (shortCount > 0) {
          await logTemplateEvent({
            runId: run.id,
            nodeKey,
            action: "fail",
            status: "warn",
            detail: `本批 ${shortCount} 张终稿缺失、过短或结构不合格，已用兜底终稿，可单张重细化`,
          })
        }
      } catch (err) {
        await writeFallbackBatch(err instanceof Error ? err.message : String(err))
      } finally {
        doneCount += batch.length
        await logTemplateEvent({
          runId: run.id,
          nodeKey,
          action: "start",
          status: "ok",
          detail: `终稿细化进度：${doneCount}/${targets.length} 张（AI 细化 ${aiCount}，兜底 ${fallbackCount}）`,
        })
      }
    }

    // 并发池：批并发按对话三层槽位上限拉满（见 resolvePromptBatchConcurrency）
    const batchConcurrency = await resolvePromptBatchConcurrency(ctx, model, batches.length)
    let cursor = 0
    const workers = Array.from(
      { length: batchConcurrency },
      async () => {
        while (cursor < batches.length) {
          const batch = batches[cursor]!
          cursor += 1
          await runBatch(batch)
        }
      },
    )
    await Promise.all(workers)

    await logTemplateEvent({
      runId: run.id,
      nodeKey,
      action: "done",
      status: "ok",
      detail:
        `终稿细化完成：AI 细化 ${aiCount} 张` +
        (fallbackCount > 0 ? `，兜底 ${fallbackCount} 张（可单张重细化）` : "") +
        "，请在终稿页逐张查看后确认开始生图",
    })
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
    "追问范围硬约束：只允许围绕 ①风格（艺术媒介/画风/色调氛围）②内容（画面主体/场景元素/文化题材）③主题（整套牌的主题立意与世界观）三类信息追问；严禁追问牌盒尺寸、卡片尺寸、纸张印刷、数量排版等任何生产与印制细节——这些由平台默认规格承担。",
    "免重复提问硬约束：用户初始描述或历史回答中已经明确的信息（即使没有以问答形式确认过）直接采纳为结论，不要追问、也不要做「确认式」追问（如用户已写了「水彩、深蓝金色」就不要再问媒介与色调）；只对真正缺失或含糊的维度提问。",
    "选项生成策略：每个问题先在内部围绕该用户的主题构思约 10 个候选选项（媒介/色调/构图等必须结合用户主题定制，例如海洋主题的媒介候选应围绕适合海洋的画风发散），再从中挑出最适合当前需求的 3 个作为推荐选项输出；禁止照抄下方澄清清单里的「未答默认」选项；两次对话不得给出雷同的选项组合，保证每个问题每次都有新鲜、贴题的候选。",
    "参考澄清清单（只用它核对哪些信息还缺失；清单里的选项仅是未答时的兜底默认取向，不是你的推荐选项来源）：",
    serializeClarification(),
    "【输出格式】只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：",
    '{ "analysis": "对已明确需求与仍缺失信息的简要分析（中文 2-4 句）", "filled": { "清单问题id": "已确认的结论或采用的默认取向" }, "questions": [ { "id": "问题id（沿用清单 id 或自拟）", "question": "要问用户的问题（中文，具体不空泛）", "options": ["3 个最适合当前需求的推荐选项（结合主题定制）"] } ], "ready": true|false }',
    `约束：questions 最多 ${MAX_CLARIFY_QUESTIONS} 个（信息足够时给空数组），每个问题恰好 ${MAX_CLARIFY_OPTIONS} 个推荐选项；不要重复问用户已经回答过或描述里已明确的问题；信息已足够时 ready = true。`,
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
    "当前任务：把需求澄清对话的全部结论整理成一份《设计简报》，供后续风格策划、初稿/终稿设计与审核直接引用。",
    "简报用中文书写，按以下小节组织（小节标题用「##」）：",
    "## 主题与世界观\n## 画面风格与媒介\n## 主辅色\n## 氛围\n## 画面内容倾向\n## 禁忌元素\n## 参考图解读",
    "要求：每节内容具体可执行，直接采用用户已确认的答案；用户未答复的小节按澄清清单的默认取向补全并注明「（默认取向）」；不写任何生产规格（尺寸/印刷/包装由平台默认承担）；没有参考图时「参考图解读」写「无」。篇幅控制在 800 字以内。",
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
    detail: "《设计简报》已生成，请确认或修改后进入初稿设计",
  })
}

/**
 * 风格规范方向（gen_style_spec）：依据简报（与可选反馈）产出 3 个候选
 * 《风格规范书》供用户选择——每个方向的 visualLanguage 即「画面风格总述」
 * （80-120 字），选定后整套终稿的 [1] 画面风格段逐字沿用。
 * 不自动选定、不创建卡牌清单：选定前不消耗初稿写作成本。
 */
async function runGenStyleDirections(
  ctx: AgentLlmContext,
  run: AgentRunRow,
  model: ChatModelRow,
  feedback?: string,
): Promise<void> {
  const previousNames = Array.isArray(run.directions)
    ? run.directions.map((d) => d.name).filter(Boolean)
    : []
  const requestLines: string[] = [
    run.brief ? `【设计简报】\n${run.brief}` : `【设计简报】\n（用户未生成简报，原始需求：${run.input.prompt}）`,
  ]
  if (feedback) requestLines.push(`【用户反馈】请围绕以下意见调整风格规范方向：${feedback}`)
  if (previousNames.length > 0) {
    requestLines.push(`【已出现过的方向名（必须避开，也不要换皮重现）】${previousNames.join("、")}`)
  }
  requestLines.push("请输出 3 个候选风格规范方向。")

  const systemPrompt = [
    rolePrompt("style_director"),
    "当前任务：依据《设计简报》产出 3 个彼此差异明显的候选《风格规范书》，供用户选择。每个方向的 visualLanguage 字段即「画面风格总述」（80-120 字），将直接用作每张卡终稿的 [1] 画面风格段，必须一次写全媒介、笔触、色调与氛围，选定后整套 78 张逐字复用。",
    "【输出格式】只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：",
    '{ "directions": [ { "id": "英文短横线标识（slug）", "name": "规范名（中文 3-6 字）", "concept": "一句话概念", "description": "2-3 句说明（核心意象与情绪）", "worldview": "世界观概述（2-4 句）", "suitMapping": [ { "suit": "权杖", "mapping": "该体系下权杖花色的意象映射" }, { "suit": "圣杯", "mapping": "…" }, { "suit": "宝剑", "mapping": "…" }, { "suit": "星币", "mapping": "…" } ], "palette": "主辅色描述", "visualLanguage": "画面风格总述（80-120 字：媒介+笔触+色调+氛围一体的完整表述）", "sampleCards": [ { "name": "牌名（如 愚者）", "scene": "该体系下这张牌的画面场景（1-2 句）" }, { "name": "…", "scene": "…" }, { "name": "…", "scene": "…" } ] }, { … }, { … } ] }',
    "约束：恰好 3 个方向、方向名互不重复；每个 visualLanguage 不少于 40 字；suitMapping 必须覆盖 权杖/圣杯/宝剑/星币 四花色；sampleCards 恰好 3 张（建议从 愚者/女祭司/恋人/命运之轮/月亮/世界 中选取）。",
  ].join("\n\n")

  const parsed = await callLlmJson<Record<string, unknown>>(ctx, model, {
    systemPrompt,
    messages: [{ role: "user", content: requestLines.join("\n\n") }],
    thinkingLevel: "medium",
    validate: (raw) => {
      validateStyleDirections(raw)
    },
  })
  const directions = validateStyleDirections(parsed)

  await db
    .update(agentRuns)
    .set({ directions, selectedDirectionId: null, updatedAt: new Date() })
    .where(eq(agentRuns.id, run.id))
  await db.insert(agentMessages).values({
    runId: run.id,
    role: "assistant",
    content: [
      `风格策划拟定了 ${directions.length} 个《风格规范书》方向：`,
      ...directions.map((d) => `· ${d.name}：${d.visualLanguage}`),
      "",
      "请选择其中一个方向开始撰写画面初稿，或告诉我要调整的地方（我会重新拟定）。",
    ].join("\n"),
    nodeKey: "style_director",
    meta: { kind: "directions", count: directions.length },
  })
  await logTemplateEvent({
    runId: run.id,
    nodeKey: "style_director",
    action: "done",
    status: "ok",
    detail: `已拟定 ${directions.length} 个《风格规范书》候选方向：${directions.map((d) => d.name).join(" / ")}，等待选择`,
  })
}

/** 旧流程（存量 run 过渡期）：世界观策划角色提示词（world_planner 角色已并入 style_director） */
const LEGACY_WORLD_PLANNER_PROMPT =
  "你是卡牌世界观策划师。依据《澄清结论》产出《风格规范书》：艺术风格与媒介、主辅色（给直观色彩描述）、构图与透视惯例、材质笔触、边框装饰语言、光影氛围、负面清单。随后产出 78 张卡牌清单：必须严格按给定骨架的顺序与牌名逐张补全一句话牌义，不得增删或改名；大阿卡纳按塔罗原型意象演绎，小阿卡纳围绕花色元素（权杖-火/圣杯-水/宝剑-风/星币-土）设计彼此可区分的画面意象。"

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
    LEGACY_WORLD_PLANNER_PROMPT,
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
    nodeKey: "style_director",
    meta: { kind: "directions", count: directions.length },
  })
  await logTemplateEvent({
    runId: run.id,
    nodeKey: "style_director",
    action: "done",
    status: "ok",
    detail: `已生成 ${directions.length} 个内容方向：${directions.map((d) => d.name).join(" / ")}`,
  })
}
