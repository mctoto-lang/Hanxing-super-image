import { signTemuRequest } from "./sign"

/**
 * TEMU 开放平台 API 客户端（网关路由 / 公共参数 / 错误码 / 频控 / 翻页）
 *
 * 网关路由依据《PA网关调用说明》迁移表（2026-05 版）：凡已迁移接口
 * 用新 type 走 PA 网关，未迁移接口走 CN 网关；同一 app_key/secret/token
 * 配套同区使用。仍走 CN 网关的接口（bg.mall.info.get、bg.goods.salesv2.get、
 * 全托核价 bg.price.review 系列、全托调价 bg.full.adjust.price 系列、备货发货
 * bg.purchaseorder 与 bg.shiporder 系列、寄样质检退货等）无需登记，默认 CN。
 */

export const TEMU_CN_GATEWAY =
  "https://openapi.kuajingmaihuo.com/openapi/router"
export const TEMU_PA_GATEWAY =
  "https://openapi-b-partner.temu.com/openapi/router"

export type TemuGateway = "CN" | "PA"

/** PA 网关接口登记（依据《PA网关调用说明》2025-06 ~ 2026-05 各迁移批次 + 广告组） */
const PA_API_TYPES = new Set<string>([
  // 基础（2025-06）
  "bg.open.accesstoken.info.get.global",
  // 货品与条码（2025-09）
  "bg.glo.goods.add",
  "bg.glo.goods.list.get",
  "bg.glo.goods.detail.get",
  "bg.glo.goods.migrate",
  "bg.glo.goods.topselling.soldout.get",
  "bg.glo.goods.custom.label.get",
  "bg.glo.goods.labelv2.get",
  // 货品生命周期（2025-10）
  "bg.glo.product.search",
  // 货品编辑（2025-09 / 2026-03）
  "bg.glo.goods.edit.task.submit",
  "bg.glo.goods.edit.task.apply",
  "bg.glo.goods.edit.sensitive.attr",
  "bg.glo.goods.edit.pictures.submit",
  "bg.glo.goods.update",
  "bg.glo.goods.add.property",
  "bg.glo.goods.edit.property",
  "bg.glo.goodslogistics.template.edit",
  "bg.glo.goods.size.template.edit",
  "bg.glo.goods.edit.guide.file",
  // 类目属性（2025-08 / 2026-01 / 2026-03 / 2026-05）
  "bg.glo.goods.parentspec.get",
  "bg.glo.goods.spec.create",
  "bg.glo.goods.photorecommendationcategory.get",
  "bg.glo.goods.cats.get",
  "bg.glo.goods.attrs.get",
  "bg.glo.goods.category.match",
  "bg.glo.goods.catsmandatory.get",
  "bg.goods.attribute.mapping.global",
  "bg.glo.goods.brand.get",
  "bg.glo.goods.accessories.get",
  // 尺码表（2026-05）
  "bg.glo.goods.sizecharts.meta.get",
  "bg.glo.goods.sizecharts.class.get",
  "bg.glo.goods.sizecharts.settings.get",
  "bg.glo.goods.sizecharts.get",
  "bg.glo.goods.sizecharts.template.create",
  "bg.glo.goods.sizecharts.create",
  // 说明书（2026-04）
  "bg.glo.goods.instructions.upload",
  "bg.glo.goods.instructionstranslation.get",
  "bg.glo.goods.translationresult.get",
  "bg.glo.goods.instructionslanguages.get",
  // 模特（2026-04）
  "bg.glo.modelinfo.get",
  "bg.glo.modelinfo.add",
  "bg.glo.modelinfo.edit",
  "bg.glo.modelcats.get",
  // 图片视频（2025-08）
  "bg.goods.image.upload.global",
  "bg.goods.texttopicture.add.global",
  "bg.glo.picturecompression.get",
  "bg.glo.colorimageurl.get",
  "bg.glo.fancy.image.cm2in",
  "bg.compliancepicture.get.global",
  "bg.algo.image.translate.global",
  "bg.algo.image.translate.result.global",
  "bg.goods.video.upload.sign.get.global",
  "bg.goods.big.video.upload.result.get.global",
  // 运费模板（2025-09）
  "bg.glo.logistics.template.get",
  // 半托库存（2025-06）
  "bg.btg.goods.stock.route.add",
  "bg.btg.goods.stock.quantity.update",
  "bg.btg.goods.stock.quantity.get",
  "bg.btg.goods.stock.warehouse.list.get",
  // 半托核价/调价（2025-06，仅自研应用）
  "bg.semi.price.review.page.query.order",
  "bg.semi.price.review.confirm.order",
  "bg.semi.price.review.reject.order",
  "bg.semi.adjust.price.page.query.order",
  "bg.semi.adjust.price.batch.review.order",
  // 申报价（2025-09，仅自研应用）
  "bg.glo.goods.price.list.get",
  // 活动（2025-09，仅自研应用）
  "bg.marketing.activity.detail.get.global",
  "bg.marketing.activity.list.get.global",
  "bg.marketing.activity.product.get.global",
  "bg.marketing.activity.session.list.get.global",
  "bg.marketing.activity.enroll.list.get.global",
  "bg.marketing.activity.enroll.submit.global",
  // JIT（2025-09）
  "bg.glo.jitmode.activate",
  // 全托库存（2026-01）
  "bg.qtg.stock.virtualinventoryjit.get",
  "bg.qtg.stock.virtualinventoryjit.edit",
  // 包装清单（包装清单-PA 组）
  "bg.themis.query.new.suit.property.list",
  "bg.themis.query.all.accessory.list",
  "bg.themis.batch.query.packing.list.detail",
  "bg.themis.batch.edit.packing.list",
  "bg.themis.polling.todo.info",
  "bg.themis.get.new.sku.suit.property.detail",
  "bg.themis.get.new.edit.form.properties",
  "bg.themis.get.customs.sku.sequence.id",
  "bg.themis.transfer.url",
  "bg.themis.new.batch.edit.suit.property",
  // 全托广告
  "bg.glo.searchrec.ad.create",
  "bg.glo.searchrec.ad.modify",
  "bg.glo.searchrec.ad.batch.modify",
  "bg.glo.searchrec.ad.roas.pred",
  "bg.glo.searchrec.ad.detail.query",
  "bg.glo.searchrec.ad.goods.create.query",
  "bg.glo.searchrec.ad.log.query",
  "bg.glo.searchrec.ad.reports.goods.query",
  "bg.glo.searchrec.ad.reports.mall.query",
])

export function gatewayForType(type: string): TemuGateway {
  return PA_API_TYPES.has(type) ? "PA" : "CN"
}

export function gatewayUrl(gateway: TemuGateway): string {
  return gateway === "PA" ? TEMU_PA_GATEWAY : TEMU_CN_GATEWAY
}

/* ------------------------------------------------------------------ */
/* 错误                                                                */
/* ------------------------------------------------------------------ */

export class TemuApiError extends Error {
  readonly errorCode?: number
  /** 官方原始错误文案（不含本地格式化包装——错误码钓鱼解析用这个） */
  readonly errorMsg?: string
  readonly requestId?: string
  readonly apiType: string
  readonly gateway: TemuGateway

  constructor(
    message: string,
    opts: {
      errorCode?: number
      errorMsg?: string
      requestId?: string
      apiType: string
      gateway: TemuGateway
    },
  ) {
    super(message)
    this.name = "TemuApiError"
    this.errorCode = opts.errorCode
    this.errorMsg = opts.errorMsg
    this.requestId = opts.requestId
    this.apiType = opts.apiType
    this.gateway = opts.gateway
  }
}

/** 7000007：access_token 已过期，需卖家中心重新授权录入 */
export class TemuTokenExpiredError extends TemuApiError {
  constructor(opts: { requestId?: string; apiType: string; gateway: TemuGateway }) {
    super(
      "access_token 已过期，请在 TEMU 卖家中心重新授权并更新店铺 token（7000007）",
      { errorCode: 7000007, ...opts },
    )
    this.name = "TemuTokenExpiredError"
  }
}

/** 网络层失败（fetch 拒绝/超时中止：连接重置、DNS、断网）——未拿到网关业务响应 */
export class TemuNetworkError extends TemuApiError {
  constructor(message: string, opts: { apiType: string; gateway: TemuGateway }) {
    super(message, opts)
    this.name = "TemuNetworkError"
  }
}

export function isTemuNetworkError(err: unknown): err is TemuNetworkError {
  return err instanceof TemuNetworkError
}

export function isTemuTokenExpired(err: unknown): err is TemuTokenExpiredError {
  return err instanceof TemuApiError && err.errorCode === 7000007
}

/** 权限类错误（7000019/7000022）：token 未勾选接口或自研专属接口未获批 */
export function isTemuPermissionError(err: unknown): err is TemuApiError {
  return (
    err instanceof TemuApiError &&
    (err.errorCode === 7000019 || err.errorCode === 7000022 || err.errorCode === 7000005)
  )
}

/* ------------------------------------------------------------------ */
/* 频控（每店铺令牌桶；官方大多接口 3~5 qps/店铺）                       */
/* ------------------------------------------------------------------ */

class TokenBucket {
  private tokens: number
  private lastRefillMs: number

  constructor(
    readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity
    this.lastRefillMs = Date.now()
  }

  private refill(): void {
    const now = Date.now()
    const add = ((now - this.lastRefillMs) / 1000) * this.refillPerSec
    if (add > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + add)
      this.lastRefillMs = now
    }
  }

  async take(): Promise<void> {
    // 上限 30s 防死循环（外部 signal 取消时由 fetch 阶段抛出）
    for (let waited = 0; waited < 30_000; ) {
      this.refill()
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      const deficitMs = ((1 - this.tokens) / this.refillPerSec) * 1000
      const sleepMs = Math.max(20, Math.ceil(deficitMs))
      await new Promise((r) => setTimeout(r, sleepMs))
      waited += sleepMs
    }
    throw new Error("TEMU API 频控等待超时（30s）")
  }
}

const rateBuckets = new Map<string, TokenBucket>()

/* 跨进程最小间隔闸门（Redis）：worker 与 Web 进程各持进程内令牌桶，同店
 * 叠加可达 2×qps 超官方限制；此闸门用 Redis 服务器时间戳保证同店相邻两次
 * 调用跨进程间隔 ≥1000/qps ms。Redis 不可用时一次性降级（warn 后本进程
 * 直接放行），行为回到进程内桶 + 瞬时错误重试兜底。 */
const RATE_GATE_LUA = `
local last = redis.call('GET', KEYS[1])
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
if last then
  local wait = tonumber(ARGV[1]) - (now - tonumber(last))
  if wait > 0 then return wait end
end
redis.call('SET', KEYS[1], tostring(now), 'PX', 5000)
return 0`

/** 等待累计上限：重度竞争时放行退化为进程内桶行为，不与令牌桶的 30s 叠加 */
const RATE_GATE_MAX_WAIT_MS = 5_000

let redisGateImport: Promise<typeof import("../redis")> | null = null
let redisGateDisabled = false
let redisGateWarned = false

function disableRedisGate(): void {
  redisGateDisabled = true
  if (!redisGateWarned) {
    redisGateWarned = true
    console.warn("[temu-rate-gate] Redis 不可用，跨进程限速降级为进程内令牌桶 + 瞬时错误重试")
  }
}

async function crossProcessRateGate(key: string, qps: number): Promise<void> {
  if (redisGateDisabled) return
  try {
    redisGateImport ??= import("../redis")
    const { redis } = await redisGateImport
    const redisKey = `hanxing:temu:rate-gate:${key}`
    const minIntervalMs = Math.ceil(1000 / qps)
    for (let waited = 0; waited < RATE_GATE_MAX_WAIT_MS; ) {
      let waitMs: number
      try {
        waitMs = Number(await redis.eval(RATE_GATE_LUA, 1, redisKey, minIntervalMs)) || 0
      } catch {
        disableRedisGate()
        return
      }
      if (waitMs <= 0) return
      const sleepMs = Math.min(waitMs, 500)
      await new Promise((r) => setTimeout(r, sleepMs))
      waited += sleepMs
    }
  } catch {
    disableRedisGate()
  }
}

/** 仅测试用：复位跨进程闸门状态 */
export function resetTemuRateGateForTest(): void {
  redisGateImport = null
  redisGateDisabled = false
  redisGateWarned = false
}

function takeRateToken(key: string, qps: number): Promise<void> {
  let bucket = rateBuckets.get(key)
  if (!bucket || bucket.capacity !== qps) {
    bucket = new TokenBucket(qps, qps)
    rateBuckets.set(key, bucket)
  }
  return bucket.take().then(() => crossProcessRateGate(key, qps))
}

/* ------------------------------------------------------------------ */
/* 调用                                                                */
/* ------------------------------------------------------------------ */

export interface TemuEnvelope<T = unknown> {
  result: T
  success: boolean
  requestId?: string
  errorCode?: number
  errorMsg?: string
}

export interface TemuCallContext {
  appKey: string
  appSecret: string
  accessToken: string
  /** 频控维度（默认 accessToken，即每店铺一个桶） */
  rateKey?: string
  /** 每秒请求上限，默认 3（官方大多接口 3~5 qps/店铺） */
  qps?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** 测试注入 */
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 15_000

function buildBody(
  type: string,
  params: Record<string, unknown>,
  ctx: TemuCallContext,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type,
    timestamp: Math.floor(Date.now() / 1000),
    app_key: ctx.appKey,
    data_type: "JSON",
    access_token: ctx.accessToken,
    ...params,
  }
  body.sign = signTemuRequest(body, ctx.appSecret)
  return body
}

function toApiError(
  envelope: TemuEnvelope,
  apiType: string,
  gateway: TemuGateway,
): TemuApiError {
  if (envelope.errorCode === 7000007) {
    return new TemuTokenExpiredError({
      requestId: envelope.requestId,
      apiType,
      gateway,
    })
  }
  const codeText = envelope.errorCode !== undefined ? `（${envelope.errorCode}）` : ""
  return new TemuApiError(
    `TEMU 接口 ${apiType} 返回失败${codeText}：${envelope.errorMsg ?? "未知错误"}`,
    {
      errorCode: envelope.errorCode,
      errorMsg: envelope.errorMsg,
      requestId: envelope.requestId,
      apiType,
      gateway,
    },
  )
}

async function postOnce<T>(
  type: string,
  body: Record<string, unknown>,
  ctx: TemuCallContext,
): Promise<{ envelope: TemuEnvelope<T>; gateway: TemuGateway }> {
  // 外部取消信号已处于 aborted 时立即失败：对已 abort 的 signal 注册
  // addEventListener 永不回调，fetch 会一直跑到超时——取消语义失效。
  // 抛 AbortError（非 TemuNetworkError，不走 1.5s 延迟重试）
  if (ctx.signal?.aborted) {
    throw new DOMException("TEMU 请求已取消（外部 signal 已中止）", "AbortError")
  }
  const gateway = gatewayForType(type)
  const url = gatewayUrl(gateway)
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  ctx.signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const doFetch = ctx.fetchImpl ?? fetch
    let res: Response
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      if (err instanceof TemuApiError) throw err
      // 网络层拒绝（undici "fetch failed"/超时中止）：底层原因在 cause（如
      // ECONNRESET），透传出来才能从同步日志定位是哪类网络问题
      const cause = err instanceof Error && err.cause instanceof Error
        ? `（${(err.cause as NodeJS.ErrnoException).code ?? err.cause.message}）`
        : ""
      throw new TemuNetworkError(
        `TEMU 网关请求失败（${gateway}）：${err instanceof Error ? err.message : String(err)}${cause}`,
        { apiType: type, gateway },
      )
    }
    if (!res.ok) {
      throw new TemuApiError(
        `TEMU 接口 ${type} HTTP ${res.status}（${gateway} 网关）`,
        { apiType: type, gateway },
      )
    }
    const envelope = (await res.json()) as TemuEnvelope<T>
    return { envelope, gateway }
  } finally {
    clearTimeout(timer)
    ctx.signal?.removeEventListener("abort", onAbort)
  }
}

/**
 * 官方标注「可重试」的瞬时错误码：服务器抖动 / 系统异常 / 参数级偶发
 * （各接口文档的错误码表，如 salesv2 的 100000000 → please try again later；
 * 4000000 SYSTEM_EXCEPTION 为网关级瞬时异常，多店连跑突发负载下实测出现、
 * 单次重试即恢复）。
 */
const RETRYABLE_ERROR_CODES = new Set<number>([
  1000000, 1000001, 1000005, 100000000, 4000000,
  // 接口级「处理中，稍后重试」（如 bg.compliancepicture 图片异步处理）
  5000000,
])

/**
 * 调用 TEMU 开放平台接口（自动网关路由、签名、频控、瞬时错误/时间戳漂移重试）
 *
 * 返回 success=true 的 envelope（result 为业务数据）；
 * 失败抛 TemuApiError（token 过期为 TemuTokenExpiredError）。
 */
export async function callTemuApi<T = unknown>(
  type: string,
  params: Record<string, unknown>,
  ctx: TemuCallContext,
): Promise<TemuEnvelope<T>> {
  await takeRateToken(ctx.rateKey ?? ctx.accessToken, ctx.qps ?? 3)

  let attempt = 0
  for (;;) {
    attempt += 1
    const body = buildBody(type, params, ctx)
    const gateway = gatewayForType(type)
    let envelope: TemuEnvelope<T>
    try {
      envelope = (await postOnce<T>(type, body, ctx)).envelope
    } catch (err) {
      // 网络层失败（连接重置/DNS 抖动/超时中止）与瞬时错误码同等对待：
      // 首次延迟 1.5s 重试一次吸收瞬时网络抖动；持续断网快速失败不受影响
      if (err instanceof TemuNetworkError && attempt === 1) {
        await new Promise((r) => setTimeout(r, 1500))
        continue
      }
      throw err
    }
    if (envelope.success) return envelope
    // 7000010/11 时间戳漂移：重取时间戳重签重试一次；
    // 瞬时错误码：延迟 1.5s 重试一次（官方口径 please try again later）
    const drift =
      envelope.errorCode === 7000010 || envelope.errorCode === 7000011
    const transient =
      envelope.errorCode !== undefined && RETRYABLE_ERROR_CODES.has(envelope.errorCode)
    if (attempt === 1 && (drift || transient)) {
      if (transient && !drift) await new Promise((r) => setTimeout(r, 1500))
      continue
    }
    throw toApiError(envelope, type, gateway)
  }
}

/**
 * 通用翻页遍历：逐页调用，把 result 交给 handler；
 * handler 返回 false 时停止（用于自定义 hasMore 判断）。
 * 注意：bg.glo.goods.list.get 等接口的页码字段是 page，默认 pageNo。
 */
export async function forEachTemuPage<T = unknown>(
  type: string,
  params: Record<string, unknown>,
  ctx: TemuCallContext,
  handle: (result: T, pageNo: number) => boolean | void | Promise<boolean | void>,
  opts?: {
    pageSize?: number
    maxPages?: number
    pageField?: string
  },
): Promise<{ pages: number }> {
  const pageSize = opts?.pageSize ?? 50
  const maxPages = opts?.maxPages ?? 500
  const pageField = opts?.pageField ?? "pageNo"
  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const envelope = await callTemuApi<T>(
      type,
      { ...params, [pageField]: pageNo, pageSize },
      ctx,
    )
    const goOn = await handle(envelope.result, pageNo)
    if (goOn === false) return { pages: pageNo }
  }
  return { pages: maxPages }
}
