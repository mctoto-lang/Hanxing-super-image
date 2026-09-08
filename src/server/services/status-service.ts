import { and, count, desc, eq, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  chatApiConfigs,
  chatTasks,
  generationTasks,
  models,
  serviceStatusSamples,
} from "@/db/schema"
import { decrypt } from "@/lib/crypto"
import { listMockupConfigs, loadMockupConfig } from "@/lib/mockup/settings"
import { redis } from "@/lib/redis"
import {
  loadStorageConfig,
  toInternalCosFetchUrl,
} from "@/lib/storage/config"
import type {
  HistoryPoint,
  ServiceHealth,
  ServiceKey,
  ServiceStatusItemView,
  ServiceStatusView,
} from "@/lib/service-status/types"

export type {
  HistoryPoint,
  ServiceHealth,
  ServiceKey,
  ServiceStatusItemView,
  ServiceStatusView,
} from "@/lib/service-status/types"

/**
 * 服务可用性观测（「服务状态检测」弹窗）
 *
 * 五个服务（展示顺序）：
 *   - chat（AI Chat API）：企业任务量最高的 chat_api_config 端点；
 *   - ai（AI Image API）：企业任务量最高的 model 端点；
 *   - ps-api（Photoshop API）：GET {apiBaseUrl}/health，无需鉴权；
 *   - storage（分布式存储）：COS 桶根 URL HEAD（200/403=桶在线，
 *     404=桶不存在）；平台级配置（system_setting key="storage"）；
 *   - postgres（系统级服务）：PostgreSQL SELECT 1 + Redis ping 综合
 *     （采样键沿用 postgres，保留既有历史）。
 *
 * AI 端点探测全部为只读请求（GET /models 列模型），不提交生图/对话
 * 任务、不消耗额度；收到任意 HTTP 响应（含 401/404/429）即视为服务
 * 在线，仅网络错误判为故障。
 *
 * 历史条：service_status_sample 表每服务每 5 分钟采样槽一条（同槽
 * 反复采样 upsert 覆盖为最新状态），定时采样（worker 5 分钟循环 /
 * cron 路由兜底）；弹窗展示最近 30 个槽（约 2.5 小时），与模板的
 * 30 根历史条一致；样本保留 48 小时后自动清理。
 *
 * 实时探测缓存：检测间隔统一 5 分钟（弹窗自动刷新与服务端缓存 TTL
 * 一致），进程内缓存 + 同 key 并发去重（仿 template-thumbnail 模式）。
 */

/** 弹窗历史条根数（与模板一致 = 最近 30 个采样槽，约 2.5 小时） */
export const SERVICE_STATUS_HISTORY_SLOTS = 30
/** 采样槽间隔（ms，检测间隔统一 5 分钟） */
export const SLOT_INTERVAL_MS = 300_000
/** 样本保留时长（ms），过期清理防止无限增长 */
const SAMPLE_RETENTION_MS = 48 * 3_600_000

/** 外部端点探测超时（ms） */
const PROBE_TIMEOUT_MS = 5_000
/** 实时探测结果进程内缓存时长（ms，检测间隔统一 5 分钟） */
const LIVE_CACHE_TTL_MS = 300_000
/** 采样遍历企业的并发上限 */
const SAMPLE_CONCURRENCY = 4

// ── 外部 API 端点探测（AI 生图 / AI Chat，只读） ───────────────────

/** 一个外部端点探测目标 */
interface ProbeTarget {
  origin: string
  probeUrl: string
  headers: Record<string, string>
}

/** OpenAI 兼容 base → {base}/models（按 /v1 归一化） */
function openAiModelsUrl(base: string): string {
  const url = base.replace(/\/+$/, "")
  return url.endsWith("/v1") ? `${url}/models` : `${url}/v1/models`
}

interface ImageModelRow {
  apiEndpoint: string
  apiFormat: string
  apiKeyEncrypted: string
}

function toImageTarget(row: ImageModelRow): ProbeTarget | null {
  let origin: string
  try {
    origin = new URL(row.apiEndpoint).origin
  } catch {
    return null
  }
  let apiKey = ""
  try {
    apiKey = decrypt(row.apiKeyEncrypted)
  } catch {
    apiKey = ""
  }
  const base = row.apiEndpoint.replace(/\/+$/, "")
  // openai 格式探测 {base}/v1/models；jimeng 等私有格式探测 origin 可达性
  return row.apiFormat === "openai"
    ? {
        origin,
        probeUrl: openAiModelsUrl(base),
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      }
    : { origin, probeUrl: origin, headers: {} }
}

interface ChatModelRow {
  apiEndpoint: string
  formatType: string
  apiKeyEncrypted: string
}

function toChatTarget(row: ChatModelRow): ProbeTarget | null {
  let origin: string
  try {
    origin = new URL(row.apiEndpoint).origin
  } catch {
    return null
  }
  let apiKey = ""
  try {
    apiKey = decrypt(row.apiKeyEncrypted)
  } catch {
    apiKey = ""
  }
  const base = row.apiEndpoint.replace(/\/+$/, "")
  switch (row.formatType) {
    case "openai":
    case "grok":
      return {
        origin,
        probeUrl: openAiModelsUrl(base),
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      }
    case "claude":
      return {
        origin,
        probeUrl: openAiModelsUrl(base),
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      }
    case "gemini":
      return {
        origin,
        probeUrl: base.includes("/v1beta")
          ? `${base}/models`
          : `${base}/v1beta/models`,
        headers: { "x-goog-api-key": apiKey },
      }
    default:
      return { origin, probeUrl: origin, headers: {} }
  }
}

async function probeEndpoint(
  target: ProbeTarget,
): Promise<{ ok: boolean; latencyMs: number | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  const startedAt = Date.now()
  try {
    await fetch(target.probeUrl, {
      signal: controller.signal,
      cache: "no-store",
      headers: target.headers,
    })
    // 收到任意 HTTP 响应（含 401/404/429）即视为服务在线
    return { ok: true, latencyMs: Date.now() - startedAt }
  } catch {
    return { ok: false, latencyMs: null }
  } finally {
    clearTimeout(timer)
  }
}

/** 企业可用的全部端点（私有优先、origin 去重、不截断）+ 主端点（用量最高） */
interface EndpointResolution {
  /** 端点总数（origin 去重后，弹窗展示「N端点」） */
  endpoints: number
  /** 主端点（用量最高；无任务时回退第一个可用端点）；无可用模型为 null */
  primary: ProbeTarget | null
}

async function resolveImageEndpoints(
  enterpriseId: string,
): Promise<EndpointResolution> {
  // 可用模型：企业私有 ∪ 平台共享（私有优先，origin 去重）
  const rows = (await db
    .select({
      apiEndpoint: models.apiEndpoint,
      apiFormat: models.apiFormat,
      apiKeyEncrypted: models.apiKeyEncrypted,
      enterpriseId: models.enterpriseId,
    })
    .from(models)
    .where(
      and(
        eq(models.isActive, true),
        or(eq(models.enterpriseId, enterpriseId), isNull(models.enterpriseId)),
      ),
    )) as Array<ImageModelRow & { enterpriseId: string | null }>

  const byOrigin = new Map<string, ProbeTarget>()
  for (const row of rows) {
    if (row.enterpriseId !== null) {
      const target = toImageTarget(row)
      if (target && !byOrigin.has(target.origin)) byOrigin.set(target.origin, target)
    }
  }
  for (const row of rows) {
    if (row.enterpriseId === null) {
      const target = toImageTarget(row)
      if (target && !byOrigin.has(target.origin)) byOrigin.set(target.origin, target)
    }
  }
  const all = [...byOrigin.values()]
  if (all.length === 0) return { endpoints: 0, primary: null }

  // 主端点：企业任务量最高的活跃模型（无任务记录回退第一个可用端点）
  const [top] = await db
    .select({ modelId: generationTasks.modelId })
    .from(generationTasks)
    .innerJoin(models, eq(generationTasks.modelId, models.id))
    .where(
      and(
        eq(generationTasks.enterpriseId, enterpriseId),
        eq(models.isActive, true),
      ),
    )
    .groupBy(generationTasks.modelId)
    .orderBy(desc(count()))
    .limit(1)

  if (top?.modelId) {
    const [row] = await db
      .select({
        apiEndpoint: models.apiEndpoint,
        apiFormat: models.apiFormat,
        apiKeyEncrypted: models.apiKeyEncrypted,
      })
      .from(models)
      .where(eq(models.id, top.modelId))
      .limit(1)
    const target = row ? toImageTarget(row) : null
    if (target) return { endpoints: all.length, primary: target }
  }
  return { endpoints: all.length, primary: all[0] }
}

async function resolveChatEndpoints(
  enterpriseId: string,
): Promise<EndpointResolution> {
  const rows = (await db
    .select({
      apiEndpoint: chatApiConfigs.apiEndpoint,
      formatType: chatApiConfigs.formatType,
      apiKeyEncrypted: chatApiConfigs.apiKeyEncrypted,
      enterpriseId: chatApiConfigs.enterpriseId,
    })
    .from(chatApiConfigs)
    .where(
      and(
        eq(chatApiConfigs.isActive, true),
        or(
          eq(chatApiConfigs.enterpriseId, enterpriseId),
          isNull(chatApiConfigs.enterpriseId),
        ),
      ),
    )) as Array<ChatModelRow & { enterpriseId: string | null }>

  const byOrigin = new Map<string, ProbeTarget>()
  for (const row of rows) {
    if (row.enterpriseId !== null) {
      const target = toChatTarget(row)
      if (target && !byOrigin.has(target.origin)) byOrigin.set(target.origin, target)
    }
  }
  for (const row of rows) {
    if (row.enterpriseId === null) {
      const target = toChatTarget(row)
      if (target && !byOrigin.has(target.origin)) byOrigin.set(target.origin, target)
    }
  }
  const all = [...byOrigin.values()]
  if (all.length === 0) return { endpoints: 0, primary: null }

  const [top] = await db
    .select({ apiConfigId: chatTasks.apiConfigId })
    .from(chatTasks)
    .innerJoin(
      chatApiConfigs,
      eq(chatTasks.apiConfigId, chatApiConfigs.id),
    )
    .where(
      and(
        eq(chatTasks.enterpriseId, enterpriseId),
        eq(chatApiConfigs.isActive, true),
      ),
    )
    .groupBy(chatTasks.apiConfigId)
    .orderBy(desc(count()))
    .limit(1)

  if (top?.apiConfigId) {
    const [row] = await db
      .select({
        apiEndpoint: chatApiConfigs.apiEndpoint,
        formatType: chatApiConfigs.formatType,
        apiKeyEncrypted: chatApiConfigs.apiKeyEncrypted,
      })
      .from(chatApiConfigs)
      .where(eq(chatApiConfigs.id, top.apiConfigId))
      .limit(1)
    const target = row ? toChatTarget(row) : null
    if (target) return { endpoints: all.length, primary: target }
  }
  return { endpoints: all.length, primary: all[0] }
}

export interface SingleEndpointProbe {
  status: ServiceHealth
  configured: boolean
  latencyMs: number | null
  /** 端点总数（如「2端点」） */
  extra: string | null
}

/** AI 生图（AI Image API）：只探测企业用量最高的端点 */
export async function probeAi(enterpriseId: string): Promise<SingleEndpointProbe> {
  const { endpoints, primary } = await resolveImageEndpoints(enterpriseId)
  if (!primary) {
    return { status: "down", configured: false, latencyMs: null, extra: null }
  }
  const result = await probeEndpoint(primary)
  return {
    status: result.ok ? "operational" : "down",
    configured: true,
    latencyMs: result.latencyMs,
    extra: `${endpoints}端点`,
  }
}

/** AI 对话（AI Chat API）：只探测企业用量最高的端点 */
export async function probeChat(enterpriseId: string): Promise<SingleEndpointProbe> {
  const { endpoints, primary } = await resolveChatEndpoints(enterpriseId)
  if (!primary) {
    return { status: "down", configured: false, latencyMs: null, extra: null }
  }
  const result = await probeEndpoint(primary)
  return {
    status: result.ok ? "operational" : "down",
    configured: true,
    latencyMs: result.latencyMs,
    extra: `${endpoints}端点`,
  }
}

// ── Photoshop API / 分布式存储 / 系统级服务 ────────────────────────

interface PsApiProbe {
  status: ServiceHealth
  latencyMs: number | null
}

export async function probePsApi(apiBaseUrl: string): Promise<PsApiProbe> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  const startedAt = Date.now()
  try {
    const res = await fetch(`${apiBaseUrl}/health`, {
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    })
    const latencyMs = Date.now() - startedAt
    const body = (await res.json().catch(() => null)) as {
      status?: unknown
    } | null
    if (!body || typeof body.status !== "string") {
      return { status: "down", latencyMs }
    }
    const status: ServiceHealth =
      body.status === "ok"
        ? "operational"
        : body.status === "degraded"
          ? "degraded"
          : "down"
    return { status, latencyMs }
  } catch {
    return { status: "down", latencyMs: null }
  } finally {
    clearTimeout(timer)
  }
}

/** 分布式存储：COS 桶根 URL HEAD（只读；200/403=桶在线，404=桶不存在） */
export async function probeStorage(): Promise<{
  configured: boolean
  status: ServiceHealth
  latencyMs: number | null
}> {
  const cfg = await loadStorageConfig()
  if (
    cfg.provider !== "cos" ||
    !(cfg.cosSecretId && cfg.cosSecretKey && cfg.cosRegion && cfg.cosBucket)
  ) {
    return { configured: false, status: "down", latencyMs: null }
  }

  let url: URL
  try {
    url = new URL(`https://${cfg.cosBucket}.cos.${cfg.cosRegion}.myqcloud.com/`)
  } catch {
    return { configured: true, status: "down", latencyMs: null }
  }
  const probeUrl = toInternalCosFetchUrl(url, cfg)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  const startedAt = Date.now()
  try {
    const res = await fetch(probeUrl, {
      method: "HEAD",
      signal: controller.signal,
      cache: "no-store",
    })
    const latencyMs = Date.now() - startedAt
    // 403 = 未签名访问被拒（桶存在、COS 可达）；404/5xx = 桶不存在或服务异常
    const status: ServiceHealth =
      res.status === 404 || res.status >= 500 ? "down" : "operational"
    return { configured: true, status, latencyMs }
  } catch {
    return { configured: true, status: "down", latencyMs: null }
  } finally {
    clearTimeout(timer)
  }
}

/** 系统级服务：PostgreSQL + Redis 综合（2/2 operational、1/2 degraded、0/2 down） */
export async function probeSystem(): Promise<{
  status: ServiceHealth
  latencyMs: number | null
}> {
  const startedAt = Date.now()
  let postgres = false
  let redisOk = false
  try {
    await db.execute(sql`SELECT 1`)
    postgres = true
  } catch {
    // ignore
  }
  try {
    if ((await redis.ping()) === "PONG") redisOk = true
  } catch {
    // ignore
  }
  const status: ServiceHealth =
    postgres && redisOk ? "operational" : postgres || redisOk ? "degraded" : "down"
  return { status, latencyMs: Date.now() - startedAt }
}

// ── 定时采样（每 5 分钟槽一条 upsert，同槽覆盖为最新状态） ───────

/** 时间对齐到所在 5 分钟槽的起点（UTC） */
function floorToSlot(date: Date): Date {
  return new Date(Math.floor(date.getTime() / SLOT_INTERVAL_MS) * SLOT_INTERVAL_MS)
}

async function upsertSample(params: {
  serviceType: ServiceKey
  enterpriseId: string | null
  status: ServiceHealth
  latencyMs: number | null
}): Promise<void> {
  await db
    .insert(serviceStatusSamples)
    .values({
      serviceType: params.serviceType,
      enterpriseId: params.enterpriseId,
      slot: floorToSlot(new Date()),
      status: params.status,
      latencyMs: params.latencyMs,
      sampledAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        serviceStatusSamples.serviceType,
        serviceStatusSamples.enterpriseId,
        serviceStatusSamples.slot,
      ],
      set: {
        status: params.status,
        latencyMs: params.latencyMs,
        sampledAt: new Date(),
      },
    })
}

async function withConcurrencyLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let active = 0
  const waiters: Array<() => void> = []
  const acquire = async () => {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
    active++
  }
  const release = () => {
    active--
    waiters.shift()?.()
  }
  await Promise.all(
    items.map(async (item) => {
      await acquire()
      try {
        await fn(item)
      } finally {
        release()
      }
    }),
  )
}

export interface SampleAllResult {
  system: ServiceHealth
  storage: { configured: boolean; status: ServiceHealth }
  psApi: { total: number; sampled: number; errors: number }
  ai: { enterprises: number; sampled: number }
  chat: { enterprises: number; sampled: number }
}

/**
 * 全量采样：系统级 + 分布式存储（平台级）+ 各企业 Photoshop API /
 * AI Image / AI Chat 主端点 → upsert 当前 5 分钟槽样本。供 worker
 * 循环与 cron 路由调用。附带清理 48 小时前的过期样本。
 */
export async function sampleAllServices(): Promise<SampleAllResult> {
  // 过期清理（best-effort，失败不影响采样）
  try {
    await db
      .delete(serviceStatusSamples)
      .where(lt(serviceStatusSamples.slot, new Date(Date.now() - SAMPLE_RETENTION_MS)))
  } catch {
    // ignore
  }

  // 平台级：系统级服务（采样键沿用 postgres）+ 分布式存储
  const system = await probeSystem()
  await upsertSample({
    serviceType: "postgres",
    enterpriseId: null,
    status: system.status,
    latencyMs: system.latencyMs,
  })
  const storage = await probeStorage()
  if (storage.configured) {
    await upsertSample({
      serviceType: "storage",
      enterpriseId: null,
      status: storage.status,
      latencyMs: storage.latencyMs,
    })
  }

  // 参与采样的企业 = 已配置渲染服务 ∪ 有私有生图模型 ∪ 有私有对话配置
  const configs = await listMockupConfigs()
  const enterpriseIds = new Set<string>(configs.map((c) => c.enterpriseId))
  const privateModelEnts = await db
    .selectDistinct({ enterpriseId: models.enterpriseId })
    .from(models)
    .where(and(eq(models.isActive, true), isNotNull(models.enterpriseId)))
  for (const row of privateModelEnts) {
    if (row.enterpriseId) enterpriseIds.add(row.enterpriseId)
  }
  const privateChatEnts = await db
    .selectDistinct({ enterpriseId: chatApiConfigs.enterpriseId })
    .from(chatApiConfigs)
    .where(
      and(eq(chatApiConfigs.isActive, true), isNotNull(chatApiConfigs.enterpriseId)),
    )
  for (const row of privateChatEnts) {
    if (row.enterpriseId) enterpriseIds.add(row.enterpriseId)
  }

  const psErrors = { count: 0 }
  let aiSampled = 0
  let chatSampled = 0
  const mockupByEnt = new Map(configs.map((c) => [c.enterpriseId, c]))

  await withConcurrencyLimit([...enterpriseIds], SAMPLE_CONCURRENCY, async (entId) => {
    // Photoshop API
    const mockupCfg = mockupByEnt.get(entId)
    if (mockupCfg) {
      try {
        const probe = await probePsApi(mockupCfg.apiBaseUrl)
        await upsertSample({
          serviceType: "ps-api",
          enterpriseId: entId,
          status: probe.status,
          latencyMs: probe.latencyMs,
        })
      } catch (err) {
        psErrors.count++
        console.error(
          `[status-sample] 企业 ${entId} PS-API 采样失败:`,
          err instanceof Error ? err.message : err,
        )
      }
    }
    // AI Image（只探主端点；未配置不采样）
    try {
      const ai = await probeAi(entId)
      if (ai.configured) {
        await upsertSample({
          serviceType: "ai",
          enterpriseId: entId,
          status: ai.status,
          latencyMs: ai.latencyMs,
        })
        aiSampled++
      }
    } catch (err) {
      console.error(
        `[status-sample] 企业 ${entId} AI Image 采样失败:`,
        err instanceof Error ? err.message : err,
      )
    }
    // AI Chat（只探主端点；未配置不采样）
    try {
      const chat = await probeChat(entId)
      if (chat.configured) {
        await upsertSample({
          serviceType: "chat",
          enterpriseId: entId,
          status: chat.status,
          latencyMs: chat.latencyMs,
        })
        chatSampled++
      }
    } catch (err) {
      console.error(
        `[status-sample] 企业 ${entId} AI Chat 采样失败:`,
        err instanceof Error ? err.message : err,
      )
    }
  })

  return {
    system: system.status,
    storage: { configured: storage.configured, status: storage.status },
    psApi: {
      total: configs.length,
      sampled: configs.length - psErrors.count,
      errors: psErrors.count,
    },
    ai: { enterprises: enterpriseIds.size, sampled: aiSampled },
    chat: { enterprises: enterpriseIds.size, sampled: chatSampled },
  }
}

// ── 弹窗聚合视图（实时探测 + 最近 30 个采样槽历史） ────────────────

interface LiveService {
  status: ServiceHealth
  configured: boolean
  latencyMs: number | null
  extra: string | null
  /** 该服务本次探测完成时间 */
  checkedAt: string
}

interface LiveCacheEntry {
  expiresAt: number
  chat: LiveService
  ai: LiveService
  psApi: LiveService
  storage: LiveService
  postgres: LiveService
}

const liveCache = new Map<string, LiveCacheEntry>()
const liveInflight = new Map<string, Promise<LiveCacheEntry>>()

/** 探测完成后记录各自的时间戳（每服务行右侧「最后更新」） */
function withCheckedAt<T extends object>(result: T): T & { checkedAt: string } {
  return { ...result, checkedAt: new Date().toISOString() }
}

/** 实时探测结果落当前槽（未配置不写，语义与 worker 采样一致） */
async function livePersist(
  serviceType: ServiceKey,
  enterpriseId: string | null,
  service: LiveService,
): Promise<void> {
  if (!service.configured) return
  await upsertSample({
    serviceType,
    enterpriseId,
    status: service.status,
    latencyMs: service.latencyMs,
  })
}

async function probeLiveAll(enterpriseId: string): Promise<LiveCacheEntry> {
  const [chat, ai, cfg, storage, system] = await Promise.all([
    probeChat(enterpriseId).then(withCheckedAt),
    probeAi(enterpriseId).then(withCheckedAt),
    loadMockupConfig(enterpriseId),
    probeStorage().then(withCheckedAt),
    probeSystem().then(withCheckedAt),
  ])
  const ps = cfg
    ? await probePsApi(cfg.apiBaseUrl).then(withCheckedAt)
    : null

  const entry: LiveCacheEntry = {
    expiresAt: Date.now() + LIVE_CACHE_TTL_MS,
    chat,
    ai,
    psApi: ps
      ? {
          status: ps.status,
          configured: true,
          latencyMs: ps.latencyMs,
          extra: null,
          checkedAt: ps.checkedAt,
        }
      : {
          status: "down",
          configured: false,
          latencyMs: null,
          extra: null,
          checkedAt: new Date().toISOString(),
        },
    storage: { ...storage, extra: null },
    postgres: {
      status: system.status,
      configured: true,
      latencyMs: system.latencyMs,
      extra: null,
      checkedAt: system.checkedAt,
    },
  }

  // 实时探测结果顺手写入当前采样槽（best-effort）：保证弹窗每服务
  // 「最后更新」与最新历史格同槽同色；仅真实回源走到这里（命中缓存
  // 不写），worker 循环仍独立保证槽位持续填充
  try {
    await Promise.all([
      livePersist("chat", enterpriseId, entry.chat),
      livePersist("ai", enterpriseId, entry.ai),
      livePersist("ps-api", enterpriseId, entry.psApi),
      livePersist("storage", null, entry.storage),
      livePersist("postgres", null, entry.postgres),
    ])
  } catch {
    // 采样写入失败不影响视图返回
  }

  return entry
}

/** 最近 n 个对齐的 5 分钟槽（oldest → 当前槽） */
function lastNSlots(n: number): Date[] {
  const slots: Date[] = []
  const current = floorToSlot(new Date()).getTime()
  for (let i = n - 1; i >= 0; i--) {
    slots.push(new Date(current - i * SLOT_INTERVAL_MS))
  }
  return slots
}

async function queryHistory(
  serviceType: ServiceKey,
  enterpriseId: string | null,
  sinceSlot: Date,
): Promise<Map<string, ServiceHealth>> {
  const rows = await db
    .select({
      slot: serviceStatusSamples.slot,
      status: serviceStatusSamples.status,
    })
    .from(serviceStatusSamples)
    .where(
      and(
        eq(serviceStatusSamples.serviceType, serviceType),
        enterpriseId === null
          ? isNull(serviceStatusSamples.enterpriseId)
          : eq(serviceStatusSamples.enterpriseId, enterpriseId),
        gte(serviceStatusSamples.slot, sinceSlot),
      ),
    )

  const bySlot = new Map<string, ServiceHealth>()
  for (const row of rows) {
    if (
      row.status === "operational" ||
      row.status === "degraded" ||
      row.status === "down"
    ) {
      bySlot.set(row.slot.toISOString(), row.status)
    }
  }
  return bySlot
}

function toHistorySlots(
  bySlot: Map<string, ServiceHealth>,
  slots: Date[],
): Array<HistoryPoint | null> {
  return slots.map((slot) => {
    const status = bySlot.get(slot.toISOString())
    return status ? { slot: slot.toISOString(), status } : null
  })
}

/**
 * 组装弹窗视图：五服务实时探测（5 分钟进程内缓存 + 并发去重）+ 各自
 * 最近 30 个采样槽历史 + 综合状态与正常运行占比。force=true 跳过缓存
 * 直接回源（手动刷新用）。
 */
export async function getServiceStatusView(
  enterpriseId: string,
  opts?: { force?: boolean },
): Promise<ServiceStatusView> {
  const cacheKey = `ent:${enterpriseId}`
  let live = opts?.force ? undefined : liveCache.get(cacheKey)
  if (!live || live.expiresAt < Date.now()) {
    const existing = liveInflight.get(cacheKey)
    if (existing) {
      live = await existing
    } else {
      const pending = probeLiveAll(enterpriseId)
      liveInflight.set(cacheKey, pending)
      try {
        live = await pending
        liveCache.set(cacheKey, live)
      } finally {
        if (liveInflight.get(cacheKey) === pending) liveInflight.delete(cacheKey)
      }
    }
  }

  const slots = lastNSlots(SERVICE_STATUS_HISTORY_SLOTS)
  const sinceSlot = slots[0]
  const [chatHist, aiHist, psHist, storageHist, pgHist] = await Promise.all([
    queryHistory("chat", enterpriseId, sinceSlot),
    queryHistory("ai", enterpriseId, sinceSlot),
    queryHistory("ps-api", enterpriseId, sinceSlot),
    queryHistory("storage", null, sinceSlot),
    queryHistory("postgres", null, sinceSlot),
  ])

  const services: ServiceStatusItemView[] = [
    { key: "chat", ...live.chat, history: toHistorySlots(chatHist, slots) },
    { key: "ai", ...live.ai, history: toHistorySlots(aiHist, slots) },
    { key: "ps-api", ...live.psApi, history: toHistorySlots(psHist, slots) },
    {
      key: "storage",
      ...live.storage,
      history: toHistorySlots(storageHist, slots),
    },
    {
      key: "postgres",
      ...live.postgres,
      history: toHistorySlots(pgHist, slots),
    },
  ]

  const participating = services.filter((s) => s.configured)
  const overall: ServiceHealth = participating.some((s) => s.status === "down")
    ? "down"
    : participating.some((s) => s.status === "degraded")
      ? "degraded"
      : "operational"

  const allPoints = participating.flatMap((s) =>
    s.history.filter((p): p is HistoryPoint => p !== null),
  )
  const uptimePercent =
    allPoints.length > 0
      ? Math.round(
          (allPoints.filter((p) => p.status === "operational").length /
            allPoints.length) *
            10000,
        ) / 100
      : null

  return {
    services,
    overall,
    uptimePercent,
    checkedAt: new Date().toISOString(),
  }
}
