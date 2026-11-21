import { env } from "@/lib/env"

/**
 * Apify API v2 客户端（选品工具数据抓取，0104）
 *
 * 对齐 temu-api/client.ts 模式：错误类层次 + AbortController 超时 + 有限重试。
 * 仅 worker 进程调用（Web 进程只写任务行，不发外部请求）。
 *
 * token 按调用显式传入（selection/provider-config.resolveSelectionToken 解析：
 * 企业 provider → 平台 APIFY_API_TOKEN 兜底）——dataset/run 归属启动 run 的
 * 账号，收割轮询必须用与启动一致的 token。
 *
 * 重试红线：POST /runs（启动 Actor run）**不做自动重试**——请求超时时 run
 * 可能已创建并计费，盲目重试会双跑双扣。创建失败直接抛错，由 worker 把
 * 任务置 failed + 退款，用户手动重试。GET/abort 幂等，可安全重试一次。
 */

const API_BASE = "https://api.apify.com/v2"

/** 单请求默认超时（dataset 分页拉取可能较大，放宽到 60s） */
const DEFAULT_TIMEOUT_MS = 30_000
const DATASET_TIMEOUT_MS = 60_000

export class ApifyError extends Error {
  constructor(
    message: string,
    public status?: number,
    public runId?: string,
  ) {
    super(message)
    this.name = "ApifyError"
  }
}

/** 平台级兜底 token 是否配置（企业可另配 provider 覆盖；完整判定用 provider-config.hasSelectionToken） */
export function isApifyConfigured(): boolean {
  return Boolean(env.APIFY_API_TOKEN)
}

/** Apify run 终态（TIMING-OUT/TIMED-OUT 归入失败口径） */
export type ApifyRunStatus =
  | "READY"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "ABORTED"
  | "TIMING-OUT"
  | "TIMED-OUT"
  | "DELETED"

export function isApifyTerminalFailure(status: string): boolean {
  return status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT" || status === "DELETED"
}

interface ApifyRun {
  id: string
  status: string
  defaultDatasetId: string | null
  startedAt: string | null
  finishedAt: string | null
}

async function apifyFetch(
  path: string,
  init: RequestInit & { timeoutMs?: number; token: string },
): Promise<unknown> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, token, ...rest } = init
  if (!token) throw new ApifyError("Apify token 未提供")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let resp: Response
  try {
    resp = await fetch(`${API_BASE}${path}`, {
      ...rest,
      signal: controller.signal,
      // token 走 Authorization 头（不拼 URL query，避免落入访问日志/错误日志）
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(rest.headers ?? {}),
      },
    })
  } catch (err) {
    throw new ApifyError(
      `Apify 请求失败（网络/超时）：${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    clearTimeout(timer)
  }

  const text = await resp.text()
  if (!resp.ok) {
    throw new ApifyError(
      `Apify ${resp.status} ${path.slice(0, 80)}：${text.slice(0, 300)}`,
      resp.status,
    )
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new ApifyError(`Apify 响应非 JSON：${text.slice(0, 200)}`)
  }
}

/** 幂等请求包装（GET / abort 等幂等 POST）：网络错误/5xx 重试一次（4xx 不重试直接抛） */
async function apifyIdempotent<T>(
  method: "GET" | "POST",
  path: string,
  opts: { token: string; timeoutMs?: number },
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return (await apifyFetch(path, {
        method,
        timeoutMs: opts.timeoutMs,
        token: opts.token,
      })) as T
    } catch (err) {
      const retriable =
        err instanceof ApifyError &&
        (err.status === undefined || err.status >= 500)
      if (attempt === 1 || !retriable) throw err
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  throw new Error("unreachable")
}

function apifyGet<T>(
  path: string,
  opts: { token: string; timeoutMs?: number },
): Promise<T> {
  return apifyIdempotent<T>("GET", path, opts)
}

/** 幂等 POST 包装（仅 abort 等幂等端点；POST /runs 不可重试，不走这里） */
function apifyPost<T>(
  path: string,
  opts: { token: string; timeoutMs?: number },
): Promise<T> {
  return apifyIdempotent<T>("POST", path, opts)
}

/**
 * 启动 Actor run（异步）。run options 里传 timeout（Apify 侧强制终止，兜底
 * 计费）与 maxItems（pay-per-result 按结果计费 Actor 的计费条数闸门，
 * 与用户预扣的 maxResults 对齐）。不重试（见文件头红线）。
 */
export async function startActorRun(input: {
  actorId: string
  runInput: Record<string, unknown>
  maxResults: number
  /** Apify 侧最长运行秒数（默认 10 分钟） */
  timeoutSecs?: number
  /** 调用凭证（provider-config 解析；run 与后续收割必须同 token） */
  token: string
}): Promise<{ runId: string; datasetId: string | null }> {
  // REST API 路径用 ~ 分隔（商店 URL 是 /；实测 memo23/temu-scraper 404、
  // memo23~temu-scraper 200，2026-11-19）
  const actorPath = input.actorId.replace("/", "~")
  const qs = new URLSearchParams({
    timeout: String(input.timeoutSecs ?? 600),
    maxItems: String(input.maxResults),
  })
  const data = (await apifyFetch(
    `/acts/${actorPath}/runs?${qs.toString()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.runInput),
      token: input.token,
    },
  )) as { data: ApifyRun }

  if (!data?.data?.id) {
    throw new ApifyError(`Apify 未返回 runId（actor=${input.actorId}）`)
  }
  return { runId: data.data.id, datasetId: data.data.defaultDatasetId ?? null }
}

/** 查询 run 状态（含 defaultDatasetId——创建响应里可能尚未就绪） */
export async function getActorRun(runId: string, token: string): Promise<ApifyRun> {
  const data = (await apifyGet<{ data: ApifyRun }>(`/actor-runs/${runId}`, {
    token,
  })) as { data: ApifyRun }
  if (!data?.data) throw new ApifyError(`Apify run ${runId} 不存在`, undefined, runId)
  return data.data
}

/** 中止 run（POST——该端点不接受 GET（405）；幂等，网络错误/5xx 可重试一次） */
export async function abortActorRun(runId: string, token: string): Promise<void> {
  await apifyPost(`/actor-runs/${runId}/abort?gracefully=false`, { token })
}

/** dataset 当前条数（进度估算用） */
export async function getDatasetItemCount(datasetId: string, token: string): Promise<number> {
  const data = (await apifyGet<{ data: { itemCount: number } }>(
    `/datasets/${datasetId}`,
    { token },
  )) as { data: { itemCount: number } }
  return data?.data?.itemCount ?? 0
}

/** 拉取一页 dataset 条目（clean=true 过滤空/隐藏字段） */
export async function listDatasetItems<T = Record<string, unknown>>(
  datasetId: string,
  opts: { offset: number; limit: number; token: string },
): Promise<T[]> {
  const qs = new URLSearchParams({
    clean: "true",
    format: "json",
    offset: String(opts.offset),
    limit: String(opts.limit),
  })
  const items = (await apifyFetch(
    `/datasets/${datasetId}/items?${qs.toString()}`,
    { method: "GET", timeoutMs: DATASET_TIMEOUT_MS, token: opts.token },
  )) as T[]
  return Array.isArray(items) ? items : []
}

/** dataset 条目总数上限（防止异常 Actor 无限翻页） */
export const MAX_DATASET_ITEMS_HARD_CAP = 5_000

/**
 * 翻页遍历 dataset 全部条目，逐批回调（批大小 100，入库分批）。
 * 返回遍历总条数。翻到空页或到达 hardCap 停止。
 */
export async function forEachDatasetItem(
  datasetId: string,
  onBatch: (items: Record<string, unknown>[]) => Promise<void>,
  opts: { batchSize?: number; maxItems?: number; token: string },
): Promise<number> {
  const batchSize = opts.batchSize ?? 100
  const cap = Math.min(
    opts.maxItems ?? MAX_DATASET_ITEMS_HARD_CAP,
    MAX_DATASET_ITEMS_HARD_CAP,
  )
  let offset = 0
  let total = 0
  while (offset < cap) {
    const batch = await listDatasetItems(datasetId, {
      offset,
      limit: Math.min(batchSize, cap - offset),
      token: opts.token,
    })
    if (batch.length === 0) break
    await onBatch(batch)
    total += batch.length
    offset += batch.length
    if (batch.length < batchSize) break
  }
  return total
}
