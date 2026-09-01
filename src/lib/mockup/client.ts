/**
 * psd-render-api 外部渲染服务客户端（服务端专用）
 *
 * 对接外部服务的 /v1 REST API：模板（PSD 解析/绑定/发布）、素材三步上传、
 * 渲染任务（提交/查询/取消）、模板缩略图。按企业配置实例化（各企业对接
 * 各自实例），错误信封统一为 { error, message }。
 */

export interface MockupApiConfig {
  /** 服务地址（无尾斜杠；与 MockupEnterpriseConfig 字段名对齐） */
  apiBaseUrl: string
  apiKey: string
}

/** 外部服务错误（信封 { error, message } 映射） */
export class MockupApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = "MockupApiError"
    this.code = code
    this.status = status
  }
}

const JSON_TIMEOUT_MS = 20_000
/** PSD 最大 300MB，直传放宽超时 */
const UPLOAD_TIMEOUT_MS = 180_000
/** 渲染结果下载（PNG/JPEG，通常几 MB） */
const DOWNLOAD_TIMEOUT_MS = 60_000

/**
 * 终端用户上下文（X-User-Id / X-User-Admin 透传给渲染服务）：
 * 模板归属人 / 私有模板可见性 / 渲染权限按此判断。
 */
export interface MockupUserContext {
  id: string
  /** 企业管理员（owner/admin）可见并渲染企业内非公开模板 */
  admin: boolean
}

function userHeaders(user?: MockupUserContext): Record<string, string> {
  if (!user) return {}
  const headers: Record<string, string> = { "X-User-Id": user.id }
  if (user.admin) headers["X-User-Admin"] = "true"
  return headers
}

async function apiFetch<T>(
  cfg: MockupApiConfig,
  path: string,
  init: RequestInit = {},
  timeoutMs: number = JSON_TIMEOUT_MS,
  user?: MockupUserContext,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${cfg.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        ...userHeaders(user),
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
      cache: "no-store",
    })
    if (!res.ok) {
      throw await toApiError(res)
    }
    return (await res.json()) as T
  } catch (err) {
    if (err instanceof MockupApiError) throw err
    if (err instanceof Error && err.name === "AbortError") {
      throw new MockupApiError("渲染服务请求超时", "UPSTREAM_TIMEOUT", 504)
    }
    throw new MockupApiError(
      `渲染服务连接失败：${err instanceof Error ? err.message : String(err)}`,
      "UPSTREAM_UNREACHABLE",
      502,
    )
  } finally {
    clearTimeout(timer)
  }
}

async function toApiError(res: Response): Promise<MockupApiError> {
  let code = "UPSTREAM_ERROR"
  let message = `渲染服务错误 HTTP ${res.status}`
  try {
    const body = (await res.json()) as { error?: string; message?: string }
    if (body.error) code = body.error
    if (body.message) message = body.message
  } catch {
    // 非 JSON 错误体，保留默认提示
  }
  return new MockupApiError(message, code, res.status)
}

/* ─── 类型（与外部 OpenAPI 对齐） ─── */

export interface ExternalTemplateSummary {
  templateId: string
  code: string
  name: string
  status: string
  statusLabel: string
  latestVersion: number
  published: boolean
  thumbnailObjectKey: string | null
  /** 归属用户（null=平台共享） */
  ownerUserId: string | null
  /** public=企业内可见 / private=仅归属人、企业管理员、平台超管 */
  visibility: "public" | "private"
  createdAt: string
}

/** PSD 解析出的图层树节点（递归） */
export interface ExternalLayerNode {
  layerId: number
  layerPath: string
  name: string
  type: string
  bounds?: { top: number; left: number; bottom: number; right: number }
  visible?: boolean
  /** 文本图层默认文本 */
  defaultText?: string
  /** 智能对象内部文档尺寸（替换前预处理图片参考） */
  smartObjectSize?: { width: number; height: number }
  children?: ExternalLayerNode[]
}

export interface ExternalBindingDef {
  bindingId: string
  layerId: number
  layerPath: string
  type: "smartObject" | "text" | "pixel"
  required: boolean
  label?: string
  acceptedFormats?: string[]
  fit: "cover" | "contain" | "stretch"
  maxLength?: number
  defaultFontVersionId?: string
}

export interface ExternalTemplateDetail {
  templateId: string
  code: string
  name: string
  status: string
  latestVersion: {
    versionId: string
    version: number
    published: boolean
    canvas: { width: number; height: number }
    psMinVersion?: string
    layerTree: ExternalLayerNode[]
    layerSchema: { bindings?: ExternalBindingDef[] }
    thumbnailObjectKey: string | null
    createdAt: string
  } | null
}

export interface ExternalUploadTicket {
  uploadUrl: string
  method: string
  headers: Record<string, string>
  objectKey: string
  expiresAt: string
}

export interface ExternalAssetTicket extends ExternalUploadTicket {
  assetId: string
}

export type ExternalRenderStatus =
  | "QUEUED"
  | "LEASED"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLING"
  | "CANCELLED"

export type ExternalRenderStage = "DOWNLOAD" | "RUN_JSX" | "EXPORT" | "UPLOAD"

export interface ExternalRenderJob {
  jobId: string
  status: ExternalRenderStatus
  attempt?: number
  priority?: number
  stage: ExternalRenderStage | null
  progress: number
  template?: { name: string; version?: string }
  /** 成功时的结果下载地址；本地存储模式为相对路径（/storage/download?key=…） */
  resultUrl?: string
  /** 结果下载签名令牌（本地存储模式放 Authorization 头；COS 模式为 null） */
  resultToken?: string | null
  resultExpiresAt?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  createdAt: string
  updatedAt: string
}

/* ─── 模板 ─── */

export async function listTemplates(
  cfg: MockupApiConfig,
  user?: MockupUserContext,
): Promise<ExternalTemplateSummary[]> {
  const data = await apiFetch<{ templates: ExternalTemplateSummary[] }>(
    cfg,
    "/v1/templates",
    {},
    JSON_TIMEOUT_MS,
    user,
  )
  return data.templates ?? []
}

export async function getTemplate(
  cfg: MockupApiConfig,
  templateId: string,
  user?: MockupUserContext,
): Promise<ExternalTemplateDetail> {
  return apiFetch<ExternalTemplateDetail>(
    cfg,
    `/v1/templates/${templateId}`,
    {},
    JSON_TIMEOUT_MS,
    user,
  )
}

export async function createTemplateUploadUrl(
  cfg: MockupApiConfig,
  opts: { fileName: string; sizeBytes?: number },
): Promise<ExternalUploadTicket> {
  return apiFetch<ExternalUploadTicket>(cfg, "/v1/templates/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  })
}

export async function parsePsdTemplate(
  cfg: MockupApiConfig,
  opts: {
    objectKey: string
    name: string
    psMinVersion?: string
    /** public=企业内可见 / private=仅归属人、企业管理员、平台超管 */
    visibility?: "public" | "private"
  },
  user?: MockupUserContext,
): Promise<{
  templateId: string
  templateVersionId: string
  canvas: { width: number; height: number }
  layerTree: ExternalLayerNode[]
}> {
  return apiFetch(cfg, "/v1/templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  }, JSON_TIMEOUT_MS, user)
}

export async function saveLayerBindings(
  cfg: MockupApiConfig,
  templateId: string,
  bindings: ExternalBindingDef[],
  user?: MockupUserContext,
): Promise<{ ok: boolean; templateId: string }> {
  return apiFetch(cfg, `/v1/templates/${templateId}/layer-bindings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bindings }),
  }, JSON_TIMEOUT_MS, user)
}

export async function publishTemplate(
  cfg: MockupApiConfig,
  templateId: string,
  user?: MockupUserContext,
): Promise<{ ok: boolean; templateId: string }> {
  return apiFetch(cfg, `/v1/templates/${templateId}/publish`, {
    method: "POST",
  }, JSON_TIMEOUT_MS, user)
}

/**
 * 拉取模板缩略图（未上传缩略图时 404，由调用方降级占位）。
 * 非公开模板需带用户上下文（否则 404）。
 */
export async function fetchTemplateThumbnail(
  cfg: MockupApiConfig,
  templateId: string,
  user?: MockupUserContext,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    return await fetch(`${cfg.apiBaseUrl}/v1/templates/${templateId}/thumbnail`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, ...userHeaders(user) },
      signal: controller.signal,
      cache: "no-store",
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 重新生成模板缩略图（解析时未生成成功的情况下手动补生成；
 * 非公开模板仅归属人/企业管理员可调用）。
 */
export async function regenerateTemplateThumbnail(
  cfg: MockupApiConfig,
  templateId: string,
  user?: MockupUserContext,
): Promise<{ ok: boolean; thumbnailObjectKey: string }> {
  return apiFetch(
    cfg,
    `/v1/templates/${templateId}/regenerate-thumbnail`,
    { method: "POST" },
    JSON_TIMEOUT_MS,
    user,
  )
}

/* ─── 素材三步上传 ─── */

export async function createAssetUploadUrl(
  cfg: MockupApiConfig,
  opts: { fileName: string; mimeType?: string; sizeBytes?: number },
): Promise<ExternalAssetTicket> {
  return apiFetch<ExternalAssetTicket>(cfg, "/v1/assets/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  })
}

/** 按预签名票据 PUT 文件字节（票据 headers 已含鉴权/Content-Type） */
export async function putUploadBytes(
  _cfg: MockupApiConfig,
  ticket: ExternalUploadTicket,
  bytes: Buffer,
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(ticket.uploadUrl, {
      method: ticket.method || "PUT",
      headers: ticket.headers,
      body: new Uint8Array(bytes),
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new MockupApiError(
        `文件上传到渲染服务失败 HTTP ${res.status}`,
        "UPLOAD_FAILED",
        res.status,
      )
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function completeAsset(
  cfg: MockupApiConfig,
  assetId: string,
): Promise<{ assetId: string; sha256: string; sizeBytes: number }> {
  return apiFetch(cfg, `/v1/assets/${assetId}/complete`, { method: "POST" })
}

/* ─── 渲染任务 ─── */

export async function createRenderJob(
  cfg: MockupApiConfig,
  opts: {
    templateVersionId: string
    /** 绑定 ID → 值：图片绑定 { assetId }，文字绑定 { text } */
    input: Record<string, { assetId?: string; text?: string }>
    idempotencyKey: string
    outputFormat?: "png" | "jpeg" | "psd"
    outputQuality?: number
  },
  user?: MockupUserContext,
): Promise<{ jobId: string; status: ExternalRenderStatus }> {
  return apiFetch(cfg, "/v1/render-jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": opts.idempotencyKey,
    },
    body: JSON.stringify({
      templateVersionId: opts.templateVersionId,
      input: opts.input,
      output: {
        format: opts.outputFormat ?? "png",
        ...(opts.outputQuality ? { quality: opts.outputQuality } : {}),
      },
    }),
  }, JSON_TIMEOUT_MS, user)
}

export async function getRenderJob(
  cfg: MockupApiConfig,
  jobId: string,
): Promise<ExternalRenderJob> {
  return apiFetch<ExternalRenderJob>(cfg, `/v1/render-jobs/${jobId}`)
}

export async function cancelRenderJob(
  cfg: MockupApiConfig,
  jobId: string,
  reason?: string,
): Promise<{ jobId: string; status: ExternalRenderStatus; updated: boolean }> {
  return apiFetch(cfg, `/v1/render-jobs/${jobId}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reason ? { reason } : {}),
  })
}

/**
 * 下载渲染结果字节：
 * - resultUrl 为绝对 https（COS 预签名）→ 直接下载；
 * - 为相对路径（渲染服务本地存储模式）→ 拼 baseUrl 并带
 *   Authorization: Bearer <resultToken>（外部服务随 resultUrl 一并下发）。
 */
export async function fetchResultBytes(
  cfg: MockupApiConfig,
  job: ExternalRenderJob,
): Promise<Buffer> {
  if (!job.resultUrl) {
    throw new MockupApiError("任务无结果下载地址", "NO_RESULT_URL", 409)
  }
  const isAbsolute = /^https?:\/\//i.test(job.resultUrl)
  const url = isAbsolute
    ? job.resultUrl
    : `${cfg.apiBaseUrl}${job.resultUrl.startsWith("/") ? "" : "/"}${job.resultUrl}`
  const headers: Record<string, string> = isAbsolute
    ? {}
    : { Authorization: `Bearer ${job.resultToken ?? cfg.apiKey}` }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    if (!res.ok) {
      throw new MockupApiError(
        `渲染结果下载失败 HTTP ${res.status}`,
        "RESULT_DOWNLOAD_FAILED",
        res.status,
      )
    }
    return Buffer.from(await res.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}
