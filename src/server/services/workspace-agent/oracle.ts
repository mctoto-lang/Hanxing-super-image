/**
 * 工作台 Agent 神谕卡英文文案（write_oracle_copy job）+ CSV 交付查询
 *
 * - 触发：选定创作方向且模板为 oracle58 时由 action 自动入队（与 write_prompts
 *   并行，互不依赖）；
 * - 撰写：主对话模型分批（8 张/批）为 55 张位置牌产出英文「标题 + 一句正文」
 *   （参照 POISON 示例口径：标题为凝练英文词，正文一句约 50-80 字符）；
 *   逐批 upsert workspace_agent_oracle_copy（cardId + locale='en' 唯一，
 *   onConflictDoUpdate，job 重试幂等且跳过已写行不重复计费）；
 * - 收口：55 行齐全 → 全部置 confirmed + done 事件；缺失抛错走既有指数退避。
 * - CSV：loadWorkspaceAgentOracleCsv 供下载 action 使用（列：序号/分组/
 *   英文标题/英文正文，RFC 4180 转义见 agent-templates.oracleCopyRowsToCsv）。
 */
import { and, asc, eq, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  workspaceAgentCards,
  workspaceAgentDirections,
  workspaceAgentOracleCopies,
  workspaceAgentWorkflows,
  type WorkspaceAgentJobRow,
  type WorkspaceAgentWorkflowRow,
} from "@/db/schema"
import { LlmValidationError } from "@/server/services/agent/llm-errors"
import {
  oracleCopyRowsToCsv,
  type OracleCopyCsvEntry,
} from "@/lib/workspace/agent-templates"
import { callWorkspaceAgentLlmJson, loadWorkspaceAgentChatModel } from "./llm"
import { readWorkflowInput } from "./input"
import { logWaEvent } from "./run"
import { loadLatestWorkflowForTask } from "./progress"

const COPY_BATCH_SIZE = 8
/** 标题：凝练英文词（可含撇号/连字符/空格，全大写，≤30 字符），如 POISON */
const HEADLINE_PATTERN = /^[A-Z][A-Z'&\- ]{0,29}$/
/** 正文：一句英文（参照示例约 68 字符，放宽容忍区间） */
const MESSAGE_MIN_CHARS = 30
const MESSAGE_MAX_CHARS = 140

interface LlmCopyOutput {
  index?: unknown
  headline?: unknown
  message?: unknown
}

interface ParsedCopy {
  index: number
  headline: string
  message: string
}

/** 长任务心跳：分批执行期间续期 workflow.updatedAt（stale 恢复依据） */
async function heartbeat(workflowId: string): Promise<void> {
  await db
    .update(workspaceAgentWorkflows)
    .set({ updatedAt: new Date() })
    .where(eq(workspaceAgentWorkflows.id, workflowId))
}

/** 解析并校验一批文案输出（index 与输入一致、标题/正文格式合法） */
export function parseCopyBatch(
  raw: { cards?: unknown },
  expectedIndexes: readonly number[],
): ParsedCopy[] {
  if (!raw || !Array.isArray(raw.cards) || raw.cards.length !== expectedIndexes.length) {
    throw new LlmValidationError(
      `cards 数组长度应为 ${expectedIndexes.length}，与输入卡牌一致`,
    )
  }
  const parsed = (raw.cards as LlmCopyOutput[]).map((item, i) => {
    const index = expectedIndexes[i]!
    if (typeof item?.index !== "number" || item.index !== index) {
      throw new LlmValidationError(`第 ${i + 1} 条 index 应为 ${index}`)
    }
    const headline = typeof item.headline === "string" ? item.headline.trim() : ""
    const message = typeof item.message === "string" ? item.message.trim() : ""
    if (!HEADLINE_PATTERN.test(headline)) {
      throw new LlmValidationError(
        `第 ${index} 张标题须为凝练英文词（全大写，≤30 字符），当前：「${headline}」`,
      )
    }
    if (message.length < MESSAGE_MIN_CHARS || message.length > MESSAGE_MAX_CHARS) {
      throw new LlmValidationError(
        `第 ${index} 张正文须为一句英文（${MESSAGE_MIN_CHARS}-${MESSAGE_MAX_CHARS} 字符），当前 ${message.length} 字符`,
      )
    }
    return { index, headline, message }
  })
  return parsed
}

/**
 * write_oracle_copy job：分批撰写 55 组英文文案并 upsert；已写行（draft 或
 * confirmed 且非空）跳过（重试幂等、不重复计费）。收口校验齐全后统一 confirmed。
 */
export async function runWriteOracleCopyJob(
  workflow: WorkspaceAgentWorkflowRow,
  job: WorkspaceAgentJobRow,
): Promise<{ written: number; skipped: number; total: number }> {
  const input = readWorkflowInput(workflow)
  const templateKey = input.frozenConfig?.templateKey ?? "tarot81"
  if (templateKey !== "oracle58") {
    return { written: 0, skipped: 0, total: 0 } // 非 oracle 模板误入队：空跑收口
  }
  if (!workflow.styleDoc || !workflow.selectedDirectionId) {
    throw new Error("方向未定稿（styleDoc 缺失），无法撰写神谕文案")
  }
  const model = await loadWorkspaceAgentChatModel(
    input.chatModelId ?? "",
    workflow.enterpriseId,
  )

  // 牌面卡（55 张，不含牌背/牌盒/边框）
  const faceCards = await db
    .select({
      id: workspaceAgentCards.id,
      cardIndex: workspaceAgentCards.cardIndex,
      name: workspaceAgentCards.name,
      meaning: workspaceAgentCards.meaning,
    })
    .from(workspaceAgentCards)
    .where(
      and(
        eq(workspaceAgentCards.workflowId, workflow.id),
        eq(workspaceAgentCards.kind, "face"),
      ),
    )
    .orderBy(asc(workspaceAgentCards.cardIndex))
  if (faceCards.length === 0) throw new Error("未找到神谕牌面卡，无法撰写文案")

  // 已写行（非空标题+正文）跳过：job 重试恢复时不重复调用计费
  const existing = await db
    .select({
      cardId: workspaceAgentOracleCopies.cardId,
      headline: workspaceAgentOracleCopies.headline,
      message: workspaceAgentOracleCopies.message,
    })
    .from(workspaceAgentOracleCopies)
    .where(
      and(
        eq(workspaceAgentOracleCopies.workflowId, workflow.id),
        eq(workspaceAgentOracleCopies.locale, "en"),
      ),
    )
  const doneSet = new Set(
    existing
      .filter((row) => (row.headline ?? "").trim() && (row.message ?? "").trim())
      .map((row) => row.cardId),
  )
  const targets = faceCards.filter((card) => !doneSet.has(card.id))
  const total = faceCards.length

  // 方向基调（标题/正文的主题与语气锚点）
  const [direction] = await db
    .select({
      name: workspaceAgentDirections.name,
      concept: workspaceAgentDirections.concept,
      worldview: workspaceAgentDirections.worldview,
    })
    .from(workspaceAgentDirections)
    .where(eq(workspaceAgentDirections.id, workflow.selectedDirectionId))
    .limit(1)

  if (targets.length > 0) {
    await logWaEvent({
      workflowId: workflow.id,
      enterpriseId: workflow.enterpriseId,
      nodeKey: "prompt_designer",
      action: "start",
      status: "ok",
      detail: `开始撰写神谕卡英文文案（${targets.length} 张待写 / 共 ${total} 张，英文标题 + 一句正文）`,
    })

    const systemPrompt = [
      "你是神谕卡（oracle deck）的文案作者。为每张卡撰写英文「标题 + 一句正文」，作为卡组交付物（不绘入画面）。",
      "标题（headline）：一个凝练的英文词，全大写，如 POISON、THRESHOLD、EMBER；可含撇号/连字符，不超过 30 字符。",
      "正文（message）：一句英文，30-120 字符，直接对抽卡人说话，具象、克制、有刺点；参照示例风格：",
      '  POISON — The toxicity you ignore is the dose you\'re choosing to swallow daily.',
      "正文与标题呼应该卡的组主题与位置原型（见输入），并贴合选定方向的世界观与语气；不出现卡牌术语、编号或占卜套话。",
      "【输出格式】只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：",
      '{ "cards": [ { "index": 卡牌序号（整数，与输入一致）, "headline": "英文标题（全大写）", "message": "一句英文正文" } ] }',
      `cards 数组必须与输入卡牌一一对应（数量相同、index 一致）。`,
    ].join("\n")

    const batches: (typeof targets)[] = []
    for (let i = 0; i < targets.length; i += COPY_BATCH_SIZE) {
      batches.push(targets.slice(i, i + COPY_BATCH_SIZE))
    }

    let done = 0
    for (const batch of batches) {
      const userText = [
        direction
          ? `【选定方向】${direction.name}${direction.concept ? `：${direction.concept}` : ""}`
          : "",
        direction?.worldview ? `【方向世界观】${direction.worldview}` : "",
        job.payload?.feedback
          ? `【用户反馈】${String(job.payload.feedback).slice(0, 500)}`
          : "",
        "请为以下神谕卡逐张撰写英文标题与正文：",
        JSON.stringify(
          batch.map((card) => ({
            index: card.cardIndex,
            name: card.name ?? "",
            archetype: card.meaning ?? "",
          })),
        ),
      ]
        .filter(Boolean)
        .join("\n\n")

      const parsed = await callWorkspaceAgentLlmJson<{ cards?: unknown }>({
        workflow,
        model,
        nodeKey: "prompt_designer",
        systemPrompt,
        messages: [{ role: "user", content: userText }],
        thinkingLevel: "medium",
        validate: (raw) => {
          parseCopyBatch(raw, batch.map((card) => card.cardIndex))
        },
      })
      const copies = parseCopyBatch(parsed, batch.map((card) => card.cardIndex))
      for (let i = 0; i < batch.length; i++) {
        const card = batch[i]!
        const copy = copies[i]!
        await db
          .insert(workspaceAgentOracleCopies)
          .values({
            workflowId: workflow.id,
            cardId: card.id,
            enterpriseId: workflow.enterpriseId,
            locale: "en",
            headline: copy.headline,
            message: copy.message,
            status: "draft",
          })
          .onConflictDoUpdate({
            target: [workspaceAgentOracleCopies.cardId, workspaceAgentOracleCopies.locale],
            set: {
              headline: copy.headline,
              message: copy.message,
              status: "draft",
              updatedAt: new Date(),
            },
          })
      }
      done += batch.length
      await heartbeat(workflow.id)
      await logWaEvent({
        workflowId: workflow.id,
        enterpriseId: workflow.enterpriseId,
        nodeKey: "prompt_designer",
        action: "start",
        status: "ok",
        detail: `神谕文案撰写进度：${done}/${targets.length} 张待写已完成`,
      })
    }
  }

  // 收口校验：55 行齐全（locale='en' 且非空）→ 全部 confirmed；缺失抛错重试
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workspaceAgentOracleCopies)
    .where(
      and(
        eq(workspaceAgentOracleCopies.workflowId, workflow.id),
        eq(workspaceAgentOracleCopies.locale, "en"),
        sql`${workspaceAgentOracleCopies.headline} IS NOT NULL AND ${workspaceAgentOracleCopies.headline} <> ''`,
        sql`${workspaceAgentOracleCopies.message} IS NOT NULL AND ${workspaceAgentOracleCopies.message} <> ''`,
      ),
    )
  const writtenTotal = Number(countRow?.count ?? 0)
  if (writtenTotal < total) {
    throw new Error(
      `神谕文案不齐全：${writtenTotal}/${total}（已写行保留，重试仅补缺失部分）`,
    )
  }
  await db
    .update(workspaceAgentOracleCopies)
    .set({ status: "confirmed", updatedAt: new Date() })
    .where(
      and(
        eq(workspaceAgentOracleCopies.workflowId, workflow.id),
        eq(workspaceAgentOracleCopies.locale, "en"),
      ),
    )
  await logWaEvent({
    workflowId: workflow.id,
    enterpriseId: workflow.enterpriseId,
    nodeKey: "prompt_designer",
    action: "done",
    status: "ok",
    detail: `神谕文案撰写完成：${total} 组英文标题/正文已定稿，可在 Agent 总览下载 CSV`,
  })
  return { written: targets.length, skipped: doneSet.size, total }
}

// ---------------------------------------------------------------------------
// CSV 交付查询（downloadWorkspaceAgentOracleCsvAction 的服务端聚合）
// ---------------------------------------------------------------------------

/** 组名提取：卡名形如「组一 · 启程」，取「·」前的组名；异常回退整名 */
function groupNameOfCard(card: { name: string | null }): string {
  const name = card.name ?? ""
  const separator = name.indexOf("·")
  return separator > 0 ? name.slice(0, separator).trim() : name
}

/**
 * 神谕文案 CSV：按 taskId 取最新工作流（双租户过滤）→ 校验 oracle58 与
 * 55 行 confirmed 齐全 → 产出 CSV 文本与下载文件名；不满足条件返回错误文案。
 */
export async function loadWorkspaceAgentOracleCsv(
  enterpriseId: string,
  userId: string,
  taskId: string,
): Promise<{ ok: true; csv: string; filename: string } | { ok: false; error: string }> {
  const workflow = await loadLatestWorkflowForTask(enterpriseId, userId, taskId)
  if (!workflow) return { ok: false, error: "Agent 工作流不存在" }
  const input = readWorkflowInput(workflow)
  if ((input.frozenConfig?.templateKey ?? "tarot81") !== "oracle58") {
    return { ok: false, error: "该任务不是神谕卡模板，无文案交付物" }
  }

  const rows = await db
    .select({
      cardIndex: workspaceAgentCards.cardIndex,
      name: workspaceAgentCards.name,
      headline: workspaceAgentOracleCopies.headline,
      message: workspaceAgentOracleCopies.message,
      status: workspaceAgentOracleCopies.status,
    })
    .from(workspaceAgentCards)
    .innerJoin(
      workspaceAgentOracleCopies,
      and(
        eq(workspaceAgentOracleCopies.cardId, workspaceAgentCards.id),
        eq(workspaceAgentOracleCopies.locale, "en"),
      ),
    )
    .where(
      and(
        eq(workspaceAgentCards.workflowId, workflow.id),
        eq(workspaceAgentCards.kind, "face"),
      ),
    )
    .orderBy(asc(workspaceAgentCards.cardIndex))

  if (rows.length === 0) {
    return { ok: false, error: "神谕文案尚未生成（选定方向后自动撰写）" }
  }
  const unconfirmed = rows.filter((row) => row.status !== "confirmed")
  if (unconfirmed.length > 0) {
    return {
      ok: false,
      error: `神谕文案尚未生成完成（${rows.length - unconfirmed.length}/${rows.length}）`,
    }
  }

  const entries: OracleCopyCsvEntry[] = rows.map((row) => ({
    index: row.cardIndex,
    groupName: groupNameOfCard(row),
    headline: row.headline ?? "",
    message: row.message ?? "",
  }))
  const safeTitle = (workflow.title ?? "oracle").replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 60)
  return {
    ok: true,
    csv: oracleCopyRowsToCsv(entries),
    filename: `${safeTitle}-神谕文案.csv`,
  }
}
