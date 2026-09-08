import { and, eq, gte, inArray, lt, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  chatApiConfigs,
  chatMessages,
  generationTasks,
  models,
  users,
} from "@/db/schema"

/**
 * 成员管理数据面板聚合服务（无鉴权，由 action / 集成测试调用）。
 *
 * 消耗口径：生图 = generation_task.credits_charged 累计；
 * AI 对话 = chat_message.cost_centicredits 累计（厘，100 厘 = 1 积分，
 * 与扣费流水解耦，按消息粒度精确统计）。
 * 统计范围均为本企业；KPI 卡片取本月（环比上月）；趋势取近 90 天
 * （前端按 7/30/90 天切换）；模块 / 模型 / 成员明细支持任意日期范围
 * （getUsageBreakdown，面板初始默认近 30 天）。
 *
 * 成功率口径（已结束请求）：生图 = completed / (completed + failed)；
 * 对话（assistant 消息）= completed / (completed + failed + stopped)。
 * 进行中的请求（queued / processing / streaming）不计入分母。
 * 调用次数口径：生图 = 任务数（全部状态）；对话 = assistant 消息数。
 */

/** 模块占比的固定展示顺序（与业务模块一一对应） */
const MODULE_DEFS = [
  { key: "chat", label: "AI 对话" },
  { key: "create", label: "自由创作" },
  { key: "workspace", label: "批量生图" },
  { key: "product", label: "商品图片" },
  { key: "weartry", label: "穿戴图片" },
  { key: "mockup", label: "样机渲染" },
] as const

export interface ModuleStat {
  key: string
  label: string
  /** 模块累计消耗（积分，对话为厘换算后的小数） */
  credits: number
  /** 该模块消耗最多的前 5 名成员 */
  topUsers: Array<{ name: string; credits: number }>
}

/** 模型消耗（生图模型与对话模型统一展示，两类模型表命名空间独立） */
export interface ModelStat {
  /** `image:${modelId}` / `chat:${modelId}` / `image:unknown` / `chat:unknown` */
  key: string
  /** 模型 displayName（缺省 name；无 modelId 的归入“已弃用模型”） */
  label: string
  /** 模型累计消耗（积分） */
  credits: number
  /** 调用次数（生图任务数 / assistant 消息数） */
  calls: number
}

/** 成员消耗（积分 + 调用次数） */
export interface UserUsageStat {
  name: string
  credits: number
  calls: number
}

/** 模块 / 模型 / 成员明细（按日期范围聚合） */
export interface UsageBreakdown {
  modules: ModuleStat[]
  models: ModelStat[]
  topUsers: UserUsageStat[]
}

/** 单个统计周期（自然月）的 KPI 汇总 */
export interface KpiPeriodStats {
  /** 生图任务数（全部状态，含排队 / 处理中） */
  imageCount: number
  /** 积分消耗（生图 + AI 对话） */
  credits: number
  /** 已结束生图数（completed + failed） */
  imageTotal: number
  /** 生图成功数（completed） */
  imageCompleted: number
  /** 已结束对话数（completed + failed + stopped，assistant 消息） */
  chatTotal: number
  /** 对话成功数（completed） */
  chatCompleted: number
}

export interface MemberUsageStats {
  memberTotal: number
  memberActive: number
  memberDisabled: number
  /** 本月新增成员数 */
  newMembersThisMonth: number
  /** 本月 KPI */
  monthKpi: KpiPeriodStats
  /** 上月 KPI（环比徽章用） */
  prevMonthKpi: KpiPeriodStats
  /** 近 90 天按日消耗趋势 */
  trend: Array<{ day: string; imageCredits: number; chatCredits: number }>
  /** 明细面板（模块 / 模型 / 成员，初始窗口为近 30 天） */
  breakdown: UsageBreakdown
}

/** 厘 → 积分（保留 2 位小数内的精度） */
function centiToCredits(centi: number): number {
  return Math.round(centi) / 100
}

/**
 * 统计口径时区：统一按中国标准时间切日/切月（timestamptz 的
 * date_trunc 默认按数据库会话时区分桶，通常为 UTC，直接用会把
 * 北京时间 0-8 点的消耗落进前一天）。Asia/Shanghai 自 1991 年后
 * 固定 UTC+8 无夏令时，可用固定偏移换算。
 */
const STATS_TZ = "Asia/Shanghai"
const STATS_TZ_OFFSET_MS = 8 * 3600_000

/** 某时刻在统计时区内的 YYYY-MM-DD（en-CA locale 恰好输出该格式） */
function dayKeyInTz(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: STATS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
}

/** 统计时区内某天 00:00 对应的 UTC 瞬间 */
function zonedMidnightUtc(dayKey: string): Date {
  const [y, m, d] = dayKey.split("-").map(Number)
  return new Date(Date.UTC(y!, m! - 1, d!) - STATS_TZ_OFFSET_MS)
}

/** 上一个月的 YYYY-MM（统计口径的月份回退） */
function prevMonthKey(ym: string): string {
  const y = Number(ym.slice(0, 4))
  const m = Number(ym.slice(5, 7))
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`
}

/**
 * 校验并收敛明细统计范围：YYYY-MM-DD 格式校验、from > to 时互换、
 * 结束日不超过今天、跨度不超过 365 天（含首尾）。
 */
export function normalizeBreakdownRange(
  fromRaw: string,
  toRaw: string,
): { from: string; to: string } {
  const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/
  if (!DAY_KEY.test(fromRaw) || !DAY_KEY.test(toRaw)) {
    throw new Error("无效的日期范围格式（应为 YYYY-MM-DD）")
  }
  let [from, to] = fromRaw <= toRaw ? [fromRaw, toRaw] : [toRaw, fromRaw]
  const today = dayKeyInTz(new Date())
  if (to > today) to = today
  const minFrom = dayKeyInTz(
    new Date(zonedMidnightUtc(to).getTime() - 365 * 86400_000),
  )
  if (from < minFrom) from = minFrom
  return { from, to }
}

/**
 * 模块 / 模型 / 成员消耗明细聚合（无鉴权，供看板 action 与初始加载复用）。
 *
 * 模型口径：生图按 generation_task.model_id（models 表）、对话按
 * chat_message.model_id（chat_api_config 表），两类模型命名空间独立，
 * displayName 重复时追加序号去重（前端饼图 config 以 label 为 key）。
 * 调用次数：生图 = 任务数（全部状态）；对话 = assistant 消息数。
 */
export async function getUsageBreakdown(
  enterpriseId: string,
  /** 起始日（含），YYYY-MM-DD（统计口径时区） */
  fromDay: string,
  /** 结束日（含），YYYY-MM-DD */
  toDay: string,
): Promise<UsageBreakdown> {
  const from = zonedMidnightUtc(fromDay)
  const toEnd = new Date(zonedMidnightUtc(toDay).getTime() + 86400_000)
  const imageCond = and(
    eq(generationTasks.enterpriseId, enterpriseId),
    gte(generationTasks.createdAt, from),
    lt(generationTasks.createdAt, toEnd),
  )
  const chatCond = and(
    eq(chatMessages.enterpriseId, enterpriseId),
    gte(chatMessages.createdAt, from),
    lt(chatMessages.createdAt, toEnd),
  )

  const [
    imageBySource,
    imageBySourceUser,
    imageByModel,
    chatByUser,
    chatByModel,
  ] = await Promise.all([
    db
      .select({
        source: generationTasks.source,
        credits: sql<number>`coalesce(sum(${generationTasks.creditsCharged}), 0)::int`,
      })
      .from(generationTasks)
      .where(imageCond)
      .groupBy(generationTasks.source),
    db
      .select({
        source: generationTasks.source,
        userId: generationTasks.userId,
        credits: sql<number>`coalesce(sum(${generationTasks.creditsCharged}), 0)::int`,
        calls: sql<number>`count(*)::int`,
      })
      .from(generationTasks)
      .where(imageCond)
      .groupBy(generationTasks.source, generationTasks.userId),
    db
      .select({
        modelId: generationTasks.modelId,
        credits: sql<number>`coalesce(sum(${generationTasks.creditsCharged}), 0)::int`,
        calls: sql<number>`count(*)::int`,
      })
      .from(generationTasks)
      .where(imageCond)
      .groupBy(generationTasks.modelId),
    db
      .select({
        userId: chatMessages.userId,
        centi: sql<number>`coalesce(sum(${chatMessages.costCenticredits}), 0)::int`,
        calls: sql<number>`count(*) filter (where ${chatMessages.role} = 'assistant')::int`,
      })
      .from(chatMessages)
      .where(chatCond)
      .groupBy(chatMessages.userId),
    db
      .select({
        modelId: chatMessages.modelId,
        centi: sql<number>`coalesce(sum(${chatMessages.costCenticredits}), 0)::int`,
        calls: sql<number>`count(*) filter (where ${chatMessages.role} = 'assistant')::int`,
      })
      .from(chatMessages)
      // 只统计 assistant 消息（user 消息无 modelId，会污染“已弃用模型”桶）
      .where(and(chatCond, eq(chatMessages.role, "assistant")))
      .groupBy(chatMessages.modelId),
  ])

  // ── 名称映射（成员 / 生图模型 / 对话模型，一次性取齐） ──
  const involvedUserIds = new Set<string>([
    ...imageBySourceUser.map((r) => r.userId),
    ...chatByUser.map((r) => r.userId),
  ])
  const imageModelIds = [
    ...new Set(imageByModel.map((r) => r.modelId).filter((v): v is string => !!v)),
  ]
  const chatModelIds = [
    ...new Set(chatByModel.map((r) => r.modelId).filter((v): v is string => !!v)),
  ]
  const [userRows, imageModelRows, chatModelRows] = await Promise.all([
    involvedUserIds.size > 0
      ? db
          .select({ id: users.id, username: users.username, name: users.name })
          .from(users)
          .where(inArray(users.id, [...involvedUserIds]))
      : Promise.resolve([]),
    imageModelIds.length > 0
      ? db
          .select({ id: models.id, name: models.name, displayName: models.displayName })
          .from(models)
          .where(inArray(models.id, imageModelIds))
      : Promise.resolve([]),
    chatModelIds.length > 0
      ? db
          .select({
            id: chatApiConfigs.id,
            name: chatApiConfigs.name,
            displayName: chatApiConfigs.displayName,
          })
          .from(chatApiConfigs)
          .where(inArray(chatApiConfigs.id, chatModelIds))
      : Promise.resolve([]),
  ])
  const displayName = (id: string) => {
    const row = userRows.find((r) => r.id === id)
    return row ? (row.name || row.username) : "未知成员"
  }
  const imageModelNames = new Map(
    imageModelRows.map((r) => [r.id, r.displayName || r.name]),
  )
  const chatModelNames = new Map(
    chatModelRows.map((r) => [r.id, r.displayName || r.name]),
  )

  // ── 模块占比 + 各模块 Top5 成员（对话归入 chat 模块） ──
  const moduleUserCredits = new Map<string, Map<string, number>>()
  for (const def of MODULE_DEFS) {
    moduleUserCredits.set(def.key, new Map())
  }
  for (const r of imageBySourceUser) {
    moduleUserCredits.get(r.source)?.set(r.userId, r.credits)
  }
  for (const r of chatByUser) {
    moduleUserCredits.get("chat")?.set(r.userId, centiToCredits(r.centi))
  }
  const topOf = (key: string, limit: number) =>
    [...(moduleUserCredits.get(key) ?? new Map<string, number>())]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([userId, credits]) => ({ name: displayName(userId), credits }))

  const imageSourceCredits = new Map(
    imageBySource.map((r) => [r.source, r.credits] as const),
  )
  const modules: ModuleStat[] = MODULE_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    credits:
      def.key === "chat"
        ? centiToCredits(chatByUser.reduce((sum, r) => sum + r.centi, 0))
        : (imageSourceCredits.get(def.key) ?? 0),
    topUsers: topOf(def.key, 5),
  }))

  // ── 模型消耗（生图模型 + 对话模型合并，按消耗降序） ──
  const modelAgg = new Map<string, ModelStat>()
  const addModel = (
    key: string,
    label: string,
    credits: number,
    calls: number,
  ) => {
    const cur = modelAgg.get(key) ?? { key, label, credits: 0, calls: 0 }
    cur.credits += credits
    cur.calls += calls
    modelAgg.set(key, cur)
  }
  for (const r of imageByModel) {
    addModel(
      `image:${r.modelId ?? "unknown"}`,
      r.modelId ? (imageModelNames.get(r.modelId) ?? "已弃用模型") : "已弃用模型",
      r.credits,
      r.calls,
    )
  }
  for (const r of chatByModel) {
    addModel(
      `chat:${r.modelId ?? "unknown"}`,
      r.modelId ? (chatModelNames.get(r.modelId) ?? "已弃用模型") : "已弃用模型",
      centiToCredits(r.centi),
      r.calls,
    )
  }
  const modelList = [...modelAgg.values()].sort((a, b) => b.credits - a.credits)
  // displayName 去重（同名模型追加序号，保证饼图 label 唯一）
  const labelSeen = new Map<string, number>()
  for (const m of modelList) {
    const n = (labelSeen.get(m.label) ?? 0) + 1
    labelSeen.set(m.label, n)
    if (n > 1) m.label = `${m.label}（${n}）`
  }

  // ── 成员消耗排行（积分 + 调用次数，生图 + 对话合并） ──
  const userAgg = new Map<string, { credits: number; calls: number }>()
  for (const r of imageBySourceUser) {
    const cur = userAgg.get(r.userId) ?? { credits: 0, calls: 0 }
    cur.credits += r.credits
    cur.calls += r.calls
    userAgg.set(r.userId, cur)
  }
  for (const r of chatByUser) {
    const cur = userAgg.get(r.userId) ?? { credits: 0, calls: 0 }
    cur.credits += centiToCredits(r.centi)
    cur.calls += r.calls
    userAgg.set(r.userId, cur)
  }
  const topUsers: UserUsageStat[] = [...userAgg]
    .sort((a, b) => b[1].credits - a[1].credits)
    .slice(0, 10)
    .map(([userId, v]) => ({ name: displayName(userId), ...v }))

  return { modules, models: modelList, topUsers }
}

/**
 * 企业成员使用统计聚合（无鉴权，供 action 与集成测试复用）。
 *
 * 注意：周期 KPI 的 count/sum filter 聚合中，FILTER 子句内只用列引用与
 * 字面量（日期参数一律放在 WHERE 的 gte/lt 里）——FILTER 内参数化 Date
 * 会让 postgres.js 以字符串序列化 Date 抛 ERR_INVALID_ARG_TYPE。
 */
export async function getMemberUsageStats(
  enterpriseId: string,
): Promise<MemberUsageStats> {
  const todayKey = dayKeyInTz(new Date())
  const todayStart = zonedMidnightUtc(todayKey)
  const monthStart = zonedMidnightUtc(`${todayKey.slice(0, 7)}-01`)
  const prevMonthStart = zonedMidnightUtc(`${prevMonthKey(todayKey.slice(0, 7))}-01`)
  const since30d = new Date(todayStart.getTime() - 29 * 86400_000)
  const since90d = new Date(todayStart.getTime() - 89 * 86400_000)

  // 趋势取近 90 天（供前端 7/30/90 天切换）
  const imageTrendCond = and(
    eq(generationTasks.enterpriseId, enterpriseId),
    gte(generationTasks.createdAt, since90d),
  )
  const chatTrendCond = and(
    eq(chatMessages.enterpriseId, enterpriseId),
    gte(chatMessages.createdAt, since90d),
  )

  /** 某时间窗内的生图 KPI（to 缺省为不限上界） */
  const imageKpiBetween = (from: Date, to?: Date) =>
    db
      .select({
        count: sql<number>`count(*)::int`,
        finished: sql<number>`count(*) filter (where ${generationTasks.status} in ('completed', 'failed'))::int`,
        completed: sql<number>`count(*) filter (where ${generationTasks.status} = 'completed')::int`,
        credits: sql<number>`coalesce(sum(${generationTasks.creditsCharged}), 0)::int`,
      })
      .from(generationTasks)
      .where(
        to
          ? and(
              eq(generationTasks.enterpriseId, enterpriseId),
              gte(generationTasks.createdAt, from),
              lt(generationTasks.createdAt, to),
            )
          : and(
              eq(generationTasks.enterpriseId, enterpriseId),
              gte(generationTasks.createdAt, from),
            ),
      )
  /** 某时间窗内的对话 KPI（对话次数按 assistant 消息计，口径为已结束请求） */
  const chatKpiBetween = (from: Date, to?: Date) =>
    db
      .select({
        finished: sql<number>`count(*) filter (where ${chatMessages.role} = 'assistant' and ${chatMessages.status} <> 'streaming')::int`,
        completed: sql<number>`count(*) filter (where ${chatMessages.role} = 'assistant' and ${chatMessages.status} = 'completed')::int`,
        centi: sql<number>`coalesce(sum(${chatMessages.costCenticredits}), 0)::int`,
      })
      .from(chatMessages)
      .where(
        to
          ? and(
              eq(chatMessages.enterpriseId, enterpriseId),
              gte(chatMessages.createdAt, from),
              lt(chatMessages.createdAt, to),
            )
          : and(
              eq(chatMessages.enterpriseId, enterpriseId),
              gte(chatMessages.createdAt, from),
            ),
      )

  // 日分桶表达式（时区必须内联为 SQL 字面量：参数化后 SELECT 与 GROUP BY
  // 中的表达式因参数编号不同而不被 PG 视为同一表达式，报 42803）
  const imageDayBucket = sql`date_trunc('day', ${generationTasks.createdAt} AT TIME ZONE 'Asia/Shanghai')`
  const chatDayBucket = sql`date_trunc('day', ${chatMessages.createdAt} AT TIME ZONE 'Asia/Shanghai')`

  const [
    membersByStatus,
    newMembersRow,
    imageTrend,
    chatTrend,
    imageMonthKpiRow,
    imagePrevKpiRow,
    chatMonthKpiRow,
    chatPrevKpiRow,
    breakdown,
  ] = await Promise.all([
    db
      .select({
        status: users.status,
        count: sql<number>`count(*)::int`,
      })
      .from(users)
      .where(eq(users.enterpriseId, enterpriseId))
      .groupBy(users.status),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(
        and(
          eq(users.enterpriseId, enterpriseId),
          gte(users.createdAt, monthStart),
        ),
      ),
    db
      .select({
        day: sql<string>`to_char(${imageDayBucket}, 'YYYY-MM-DD')`,
        credits: sql<number>`coalesce(sum(${generationTasks.creditsCharged}), 0)::int`,
      })
      .from(generationTasks)
      .where(imageTrendCond)
      .groupBy(imageDayBucket),
    db
      .select({
        day: sql<string>`to_char(${chatDayBucket}, 'YYYY-MM-DD')`,
        centi: sql<number>`coalesce(sum(${chatMessages.costCenticredits}), 0)::int`,
      })
      .from(chatMessages)
      .where(chatTrendCond)
      .groupBy(chatDayBucket),
    // 本月 / 上月 KPI（独立小聚合，见函数注释）
    imageKpiBetween(monthStart),
    imageKpiBetween(prevMonthStart, monthStart),
    chatKpiBetween(monthStart),
    chatKpiBetween(prevMonthStart, monthStart),
    // 明细（模块 / 模型 / 成员），面板初始窗口为近 30 天
    getUsageBreakdown(enterpriseId, dayKeyInTz(since30d), todayKey),
  ])

  // ── KPI ──
  const memberTotal = membersByStatus.reduce((sum, r) => sum + r.count, 0)
  const memberActive = membersByStatus
    .filter((r) => r.status === "active")
    .reduce((sum, r) => sum + r.count, 0)
  const toKpi = (
    img: { count: number; finished: number; completed: number; credits: number },
    chat: { finished: number; completed: number; centi: number },
  ): KpiPeriodStats => ({
    imageCount: img.count,
    credits: img.credits + centiToCredits(chat.centi),
    imageTotal: img.finished,
    imageCompleted: img.completed,
    chatTotal: chat.finished,
    chatCompleted: chat.completed,
  })
  const monthKpi = toKpi(
    imageMonthKpiRow[0] ?? { count: 0, finished: 0, completed: 0, credits: 0 },
    chatMonthKpiRow[0] ?? { finished: 0, completed: 0, centi: 0 },
  )
  const prevMonthKpi = toKpi(
    imagePrevKpiRow[0] ?? { count: 0, finished: 0, completed: 0, credits: 0 },
    chatPrevKpiRow[0] ?? { finished: 0, completed: 0, centi: 0 },
  )
  const newMembersThisMonth = newMembersRow[0]?.count ?? 0

  // ── 趋势（补齐无数据日期为 0） ──
  const imageByDay = new Map(imageTrend.map((r) => [r.day, r.credits]))
  const chatByDay = new Map(
    chatTrend.map((r) => [r.day, centiToCredits(r.centi)]),
  )
  const trend = Array.from({ length: 90 }, (_, i) => {
    const day = dayKeyInTz(new Date(todayStart.getTime() - (89 - i) * 86400_000))
    return {
      day,
      imageCredits: imageByDay.get(day) ?? 0,
      chatCredits: chatByDay.get(day) ?? 0,
    }
  })

  return {
    memberTotal,
    memberActive,
    memberDisabled: memberTotal - memberActive,
    newMembersThisMonth,
    monthKpi,
    prevMonthKpi,
    trend,
    breakdown,
  }
}
