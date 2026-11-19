/**
 * 上游模型列表拉取（OpenAI 兼容 GET {base}/v1/models；Gemini 原生
 * GET {base}/v1beta/models）
 *
 * 供模型表单「拉取模型列表」按钮使用：对接 new-api / sub2api 等 OpenAI
 * 兼容网关（或官方 OpenAI 等原生端点）时免手抄模型标识，一键拉取上游
 * 暴露的模型清单填入表单。纯 fetch 逻辑，无 DB/会话依赖。
 */
import { describeFetchError } from "@/lib/fetch-error"

/** 拉取超时（网关偶发慢；超过按失败处理，不阻塞表单） */
const FETCH_TIMEOUT_MS = 15_000
/** 错误响应体截断长度 */
const ERROR_BODY_MAX_LENGTH = 400
/** 返回模型条数上限（部分网关返回上千条，截断防止下拉卡顿） */
const MAX_MODELS = 300

/** 拉取协议：openai = OpenAI 兼容 /v1/models（Bearer）；gemini = 官方
 *  v1beta/models（x-goog-api-key，name 形如 "models/gemini-..."） */
export type UpstreamModelsProtocol = "openai" | "gemini"

/**
 * 解析模型列表端点（endpoint 习惯配到 /v1 结尾；容错裸域名与全路径）。
 * 与 resolveOpenAiGenerateEndpoint / resolveOpenAiChatEndpoint 同款归一。
 */
export function resolveModelsListEndpoint(
  endpoint: string,
  protocol: UpstreamModelsProtocol = "openai",
): string {
  const url = endpoint.trim().replace(/\/+$/, "")
  if (protocol === "gemini") {
    if (url.endsWith("/models")) return url
    if (/\/v1beta(?:\/|$)/.test(url)) return `${url}/models`
    return `${url}/v1beta/models`
  }
  if (url.endsWith("/models")) return url
  if (url.endsWith("/v1")) return `${url}/models`
  return `${url}/v1/models`
}

/** 从 /v1/models 响应提取模型 id 列表（容忍常见变体形状，去重排序截断） */
export function extractModelIds(data: unknown): string[] {
  let list: unknown = data
  if (data && typeof data === "object" && !Array.isArray(data)) {
    // OpenAI 标准 {data: [{id}]}；data 为字符串数组的中转变体也接受；
    // Gemini 原生 {models: [{name: "models/xxx"}]} 剥前缀
    const obj = data as Record<string, unknown>
    if (Array.isArray(obj.data)) {
      list = obj.data
    } else if (Array.isArray(obj.models)) {
      return [
        ...new Set(
          obj.models
            .map((m) =>
              m && typeof m === "object"
                ? (m as Record<string, unknown>).name
                : m,
            )
            .filter((n): n is string => typeof n === "string" && !!n)
            .map((n) => n.replace(/^models\//, "")),
        ),
      ]
        .sort()
        .slice(0, MAX_MODELS)
    }
  }
  if (!Array.isArray(list)) return []
  const ids: string[] = []
  for (const item of list) {
    if (typeof item === "string" && item) {
      ids.push(item)
    } else if (item && typeof item === "object") {
      const id = (item as Record<string, unknown>).id
      if (typeof id === "string" && id) ids.push(id)
    }
  }
  return [...new Set(ids)].sort().slice(0, MAX_MODELS)
}

/**
 * GET 模型列表（openai 协议 Bearer / gemini 协议 x-goog-api-key）。
 * 失败抛带端点与状态码的中文错误（调用方 catch 后直接展示 err.message）。
 */
export async function fetchUpstreamModelIds(opts: {
  endpoint: string
  apiKey: string
  protocol?: UpstreamModelsProtocol
  timeoutMs?: number
}): Promise<string[]> {
  const protocol = opts.protocol ?? "openai"
  const endpoint = resolveModelsListEndpoint(opts.endpoint, protocol)
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response: Response
    try {
      response = await fetch(endpoint, {
        headers:
          protocol === "gemini"
            ? { "x-goog-api-key": opts.apiKey }
            : { Authorization: `Bearer ${opts.apiKey}` },
        signal: controller.signal,
      })
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `拉取模型列表超时（上限 ${Math.round(timeoutMs / 1000)} 秒）`,
        )
      }
      const reason = describeFetchError(err)
      throw new Error(
        `拉取模型列表网络失败（${endpoint}）${reason ? `: ${reason}` : ""}`,
      )
    }

    const text = await response.text().catch(() => "")
    if (!response.ok) {
      throw new Error(
        `拉取模型列表 API 错误 ${response.status}: ${text.slice(0, ERROR_BODY_MAX_LENGTH)}`,
      )
    }
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error("拉取模型列表响应不是有效 JSON")
    }
    const ids = extractModelIds(data)
    if (ids.length === 0) {
      throw new Error("上游未返回可识别的模型列表（响应缺少 data[].id）")
    }
    return ids
  } finally {
    clearTimeout(timeoutId)
  }
}
