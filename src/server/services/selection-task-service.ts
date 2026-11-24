import { and, eq, gte, inArray, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { selectionTasks } from "@/db/schema"
import {
  CreditsInsufficientError,
  deductUserCredits,
} from "@/server/services/credits-service"
import { buildActorInput, hasLegacyAmazonCategoryUrl } from "@/lib/selection/input-builders"
import {
  SELECTION_DAILY_TASK_LIMIT,
  SELECTION_KEYWORD_MAX_LEN,
  estimateCredits,
  getFormFields,
  resultLimitsFor,
  type PlatformField,
  type SelectionPlatform,
} from "@/lib/selection/platforms"
import { resolveSelectionToken } from "@/lib/selection/provider-config"

/**
 * 选品任务创建核心（Server Action 与运维脚本共用）
 *
 * 本文件绝不放进 "use server" 导出（计费内部逻辑，见 credits-service
 * refundFailedTask 同款红线注释）。提交 = 单事务（insert 任务 + 预扣个人配额积分），
 * 结算/退款全部走 selection-service。
 */

/**
 * 按注册表字段声明清洗表单参数（必填/枚举/数字范围），越权键丢弃。
 * 下拉选项带 showWhen（如 Amazon 榜单品类随站点变化）时按同一条件校验——
 * 绕过前端提交不支持的组合会被拒。
 */
export function sanitizeParams(
  fields: PlatformField[],
  raw: unknown,
): { ok: true; params: Record<string, string | number> } | { ok: false; error: string } {
  if (raw != null && typeof raw !== "object") {
    return { ok: false, error: "参数格式错误" }
  }
  const input = (raw ?? {}) as Record<string, unknown>
  // 第一遍：取各字段原始值（缺省补默认值），第二遍做选项的条件校验
  const picked: Record<string, string | number | undefined> = {}
  for (const f of fields) {
    const v = input[f.key]
    if (v == null || v === "") {
      if (f.required) return { ok: false, error: `请填写「${f.label}」` }
      if (f.defaultValue != null) picked[f.key] = f.defaultValue
      continue
    }
    if (f.type === "number") {
      const n = Number(v)
      if (!Number.isFinite(n)) return { ok: false, error: `「${f.label}」须为数字` }
      if (f.min != null && n < f.min) return { ok: false, error: `「${f.label}」不得小于 ${f.min}` }
      if (f.max != null && n > f.max) return { ok: false, error: `「${f.label}」不得大于 ${f.max}` }
      picked[f.key] = n
      continue
    }
    const s = String(v).trim()
    if (s.length === 0) {
      if (f.required) return { ok: false, error: `请填写「${f.label}」` }
      continue
    }
    if (s.length > SELECTION_KEYWORD_MAX_LEN) {
      return { ok: false, error: `「${f.label}」过长（≤${SELECTION_KEYWORD_MAX_LEN} 字符）` }
    }
    picked[f.key] = s
  }
  const out: Record<string, string | number> = {}
  for (const f of fields) {
    const v = picked[f.key]
    if (v === undefined) continue
    if (f.type === "select" && f.options) {
      const opt = f.options.find((o) => o.value === String(v))
      if (!opt) return { ok: false, error: `「${f.label}」取值无效` }
      if (opt.showWhen) {
        const ref = picked[opt.showWhen.field]
        if (ref === undefined || !opt.showWhen.in.includes(String(ref))) {
          return {
            ok: false,
            error: `「${f.label}」在当前选择下暂不支持，请更换后重试`,
          }
        }
      }
    }
    out[f.key] = v
  }
  return { ok: true, params: out }
}

export interface CreateSelectionTaskInput {
  userId: string
  enterpriseId: string
  platform: SelectionPlatform
  taskType: "discover" | "market"
  params: Record<string, unknown>
  maxResults: number
  /** 计费流水里的平台名 */
  label: string
}

export type CreateSelectionTaskResult =
  | { ok: true; taskId: string; estimatedCredits: number; maxResults: number }
  | { ok: false; error: string }

/**
 * 创建抓取任务核心：校验/清洗/日限 → 单事务入库 + 预扣积分。
 * 每日任务数上限按发起人计（自然日，服务器本地时区），且只数手动提交的
 * discover/market 任务——竞品监控自动生成的 monitor/review 任务不占额度
 * （监控抓取量的防线是积分余额与暂停机制）。
 */
export async function createSelectionTask(
  input: CreateSelectionTaskInput,
): Promise<CreateSelectionTaskResult> {
  const { userId, enterpriseId } = input
  // 旧版 Amazon 发现入参（categoryUrl）残留：静默按默认品类抓取会抓错类目并扣积分，
  // 直接拒绝（存量队列任务启动与失败任务「重试」都走这里）
  if (
    input.platform === "amazon" &&
    input.taskType === "discover" &&
    hasLegacyAmazonCategoryUrl(input.params)
  ) {
    return {
      ok: false,
      error: "旧版 Amazon 榜单入参（categoryUrl）已下线，请重新选择站点与品类后提交",
    }
  }
  // 凭证解析（企业 provider → 平台 APIFY_API_TOKEN 兜底）；providerId 快照到
  // 任务行，worker 启动/收割按快照取同一 token（dataset 归属启动账号）
  const cred = await resolveSelectionToken({ enterpriseId })
  if (!cred) {
    return {
      ok: false,
      error: "企业未配置选品抓取凭证（请联系超管在平台管理配置 Apify Token）",
    }
  }
  const fields = getFormFields(input.platform, input.taskType)
  const sanitized = sanitizeParams(fields, input.params)
  if (!sanitized.ok) return { ok: false, error: sanitized.error }
  const params = sanitized.params

  // 发现模式可在注册表单独声明上下限（如 Amazon 榜单每类目硬上限 100 条）
  const limits = resultLimitsFor(input.platform, input.taskType)
  const maxResults = Math.min(Math.max(input.maxResults, limits.min), limits.max)

  const built = buildActorInput({
    platform: input.platform,
    taskType: input.taskType,
    params,
    maxResults,
  })
  const estimatedCredits = estimateCredits(input.platform, input.taskType, maxResults)

  let outcome: { ok: false; error: string } | { ok: true; taskId: string }
  try {
    outcome = await db.transaction(async (tx) => {
      // 每日任务数上限（自然日，服务器本地时区）：count+insert 放进同一事务，
      // 前置 pg advisory 事务锁串行化同用户并发创建（盐隔离其他用途的锁；
      // 锁随事务结束自动释放），避免先查后插被并发突破日限。
      // 只数手动提交的 discover/market：监控自动任务不占额度（与弹窗「今日剩余」同口径）
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${userId} || ':selection:daily'))`,
      )
      const dayStart = new Date()
      dayStart.setHours(0, 0, 0, 0)
      const [{ count: todayCount }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(selectionTasks)
        .where(
          and(
            eq(selectionTasks.userId, userId),
            gte(selectionTasks.createdAt, dayStart),
            inArray(selectionTasks.taskType, ["discover", "market"]),
          ),
        )
      if (todayCount >= SELECTION_DAILY_TASK_LIMIT) {
        return {
          ok: false as const,
          error: `今日任务数已达上限（${SELECTION_DAILY_TASK_LIMIT} 个/天）`,
        }
      }
      const [t] = await tx
        .insert(selectionTasks)
        .values({
          enterpriseId,
          userId,
          taskType: input.taskType,
          platform: input.platform,
          actorId: built.actorId,
          searchParams: params,
          keyword: built.keyword.slice(0, SELECTION_KEYWORD_MAX_LEN),
          country: built.country,
          providerId: cred.providerId,
          maxResults,
          estimatedCredits,
          status: "queued",
        })
        .returning({ id: selectionTasks.id })
      await deductUserCredits({
        enterpriseId,
        userId,
        amount: estimatedCredits,
        taskId: t!.id,
        type: "selection_deduct",
        remark: `选品任务：${input.label}「${built.keyword.slice(0, 60)}」×${maxResults}`,
        tx,
      })
      return { ok: true as const, taskId: t!.id }
    })
  } catch (err) {
    // 个人配额不足：drizzle 事务抛错即回滚，转成可读错误返回（生产环境 Next
    // 会遮蔽服务端异常消息，弹窗里的余额又是渲染时快照，须在此接住给明确提示）
    if (err instanceof CreditsInsufficientError) {
      return {
        ok: false as const,
        error: `个人配额不足（需 ${err.needed ?? estimatedCredits} 积分，当前余额 ${err.balance ?? 0}）`,
      }
    }
    throw err
  }

  if (!outcome.ok) return outcome
  return { ok: true, taskId: outcome.taskId, estimatedCredits, maxResults }
}
