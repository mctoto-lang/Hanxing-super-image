import { and, eq, isNull, or } from "drizzle-orm"
import { db } from "@/db/client"
import { chatApiConfigs, promptTemplates, workspaceApiLogs } from "@/db/schema"
import { decrypt } from "@/lib/crypto"

/**
 * 工作台 AI（提示词裂变/提取/细化/重生成/翻译，手册 §5.6、M5）
 *
 * 迁移旧项目 workspaceAI.ts 核心算法：DB 换 Drizzle，api_key 落库加密。
 * 模板占位符统一 {{prompt}} / {{count}}（旧项目标准）。
 */

export interface ChatApiConfig {
  id?: string
  /** 模型标识（OpenAI 请求体 model 参数） */
  name?: string
  displayName?: string
  apiEndpoint: string
  apiKeyEncrypted: string
  formatType: string
  /** 对话模型扩展参数（temperature / maxTokens，缺省用默认值） */
  extraConfig?: { temperature?: number; maxTokens?: number } | null
  maxConcurrent?: number
  maxRetries?: number
  apiTimeout?: number
}

export interface ExecutableTemplate {
  id: string
  type: string
  name: string
  content: string
  fissionCount: number | null
  chatApi: ChatApiConfig
}

/** 默认裂变模板（未配置时兜底） */
export const DEFAULT_FISSION_TEMPLATE =
  "请为以下主题生成 {{count}} 条互不相同、细节丰富的 AI 绘画提示词，每条用 === 分隔：\n{{prompt}}"

/**
 * 调用对话 API（OpenAI 兼容 /v1/chat/completions）
 *
 * content 支持纯文本（历史调用方）与多模态数组（vision：text + image_url）。
 */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }

export async function callChatApi(opts: {
  config: ChatApiConfig
  messages: Array<{
    role: "system" | "user" | "assistant"
    content: string | ChatContentPart[]
  }>
  signal?: AbortSignal
  timeoutMs?: number
  /** 透传 response_format（json_object）；不支持该参数的网关会报错，调用方需容错降级 */
  responseFormat?: "json_object"
  /** 调用方显式指定采样温度（优先于 extraConfig；结构化 JSON 场景传低值更稳定） */
  temperature?: number
}): Promise<string> {
  const { config, messages, signal, timeoutMs, responseFormat, temperature } =
    opts
  const apiKey = decrypt(config.apiKeyEncrypted)

  const controller = new AbortController()
  const timeoutId = setTimeout(
    () => controller.abort(),
    timeoutMs ?? (config.apiTimeout ? config.apiTimeout * 1000 : 60_000),
  )
  if (signal) signal.addEventListener("abort", () => controller.abort())

  const endpoint = config.apiEndpoint.replace(/\/+$/, "")
  const url = endpoint.endsWith("/chat/completions")
    ? endpoint
    : endpoint.endsWith("/v1")
      ? `${endpoint}/chat/completions`
      : `${endpoint}/v1/chat/completions`

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.name,
      messages,
      temperature: temperature ?? config.extraConfig?.temperature ?? 0.8,
      ...(config.extraConfig?.maxTokens
        ? { max_tokens: config.extraConfig.maxTokens }
        : {}),
      ...(responseFormat ? { response_format: { type: responseFormat } } : {}),
    }),
    signal: controller.signal,
  })
  clearTimeout(timeoutId)

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`对话 API 错误 ${response.status}: ${text.slice(0, 200)}`)
  }

  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== "string") {
    throw new Error("对话 API 响应格式异常（无 content）")
  }
  return content
}

/**
 * 解析 AI 返回的 JSON（容错版）：
 * 剥离 ```json 围栏与前后杂文 → 取首个平衡的 JSON 对象解析。
 * 供 AI 辅写 / 智能匹配等需要结构化输出的调用方使用。
 */
export function parseAiJson<T>(raw: string): T {
  let text = raw.trim()
  // 剥离 markdown 围栏（```json ... ``` 或 ``` ... ```）
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  if (fence) text = fence[1]!.trim()
  // 直接尝试
  try {
    return JSON.parse(text) as T
  } catch {
    // 取首个平衡的大括号块（跳过模型输出的引导语）
    const start = text.indexOf("{")
    if (start >= 0) {
      let depth = 0
      let inStr = false
      let esc = false
      for (let i = start; i < text.length; i++) {
        const ch = text[i]!
        if (esc) {
          esc = false
          continue
        }
        if (ch === "\\") {
          if (inStr) esc = true
          continue
        }
        if (ch === '"') {
          inStr = !inStr
          continue
        }
        if (inStr) continue
        if (ch === "{") depth++
        else if (ch === "}") {
          depth--
          if (depth === 0) {
            return JSON.parse(text.slice(start, i + 1)) as T
          }
        }
      }
    }
    throw new Error("AI 返回内容无法解析为 JSON")
  }
}

/** 替换模板占位符 */
export function fillTemplate(
  template: string,
  vars: { prompt?: string; count?: number | string },
): string {
  return template
    .replace(/\{\{prompt\}\}/g, vars.prompt ?? "")
    .replace(/\{\{count\}\}/g, String(vars.count ?? ""))
    .replace(/\$\{prompt\}/g, vars.prompt ?? "")
    .replace(/\$\{count\}/g, String(vars.count ?? ""))
    .replace(/\$\{theme\}/g, vars.prompt ?? "")
}

/**
 * 解析裂变/提取结果：优先数字编号列表，其次 bullet，最后按双换行分段。
 */
export function extractPrompts(text: string): string[] {
  const lines = text
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean)

  // 数字编号：1. / 1、 / 1)
  const numbered = lines
    .map((l) => l.replace(/^\s*\d+\s*[.、)]\s*/, "").trim())
    .filter(Boolean)
  if (numbered.length >= 2) return numbered

  // bullet：- / • / *
  const bullet = lines
    .filter((l) => /^[-•*]\s+/.test(l))
    .map((l) => l.replace(/^[-•*]\s+/, "").trim())
    .filter(Boolean)
  if (bullet.length >= 2) return bullet

  // === 分隔
  const bySep = text
    .split(/={3,}/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (bySep.length >= 2) return bySep

  // 双换行分段
  const byPara = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (byPara.length >= 2) return byPara

  // 整段当作一条
  const whole = text.trim()
  return whole ? [whole] : []
}

/**
 * 解析批量替换的编号提示词：优先 JSON，正则兜底。
 */
export function extractNumberedPrompts(
  text: string,
): Array<{ cardIndex: number; prompt: string }> {
  // JSON 解析
  try {
    const parsed = JSON.parse(text)
    const arr: unknown = Array.isArray(parsed)
      ? parsed
      : (parsed as { items?: unknown; prompts?: unknown })?.items ??
        (parsed as { prompts?: unknown })?.prompts
    if (Array.isArray(arr)) {
      const result: Array<{ cardIndex: number; prompt: string }> = []
      for (const item of arr) {
        if (!item || typeof item !== "object") continue
        const obj = item as { card_index?: unknown; cardIndex?: unknown; prompt?: unknown }
        const idx = Number(obj.card_index ?? obj.cardIndex)
        const prompt = String(obj.prompt ?? "").trim()
        if (Number.isInteger(idx) && idx > 0 && prompt) {
          result.push({ cardIndex: idx, prompt })
        }
      }
      if (result.length > 0) return result
    }
  } catch {
    // 非 JSON，走正则
  }

  // 正则：匹配 "数字. 提示词" 或 "数字、提示词"
  const result: Array<{ cardIndex: number; prompt: string }> = []
  const regex = /(\d+)\s*[.、)]\s*([^\n]+)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const idx = Number(match[1])
    const prompt = match[2]!.trim()
    if (idx > 0 && prompt) result.push({ cardIndex: idx, prompt })
  }
  return result
}

/**
 * 获取可执行模板（含关联 chatApi 配置，解密 key）。
 * 校验：status=active、可见性（public 或 owner=userId 或 admin）、关联 chatApi active。
 */
export async function getExecutableTemplate(opts: {
  templateId: string
  expectedType?: string
  enterpriseId: string
  userId: string
  isAdmin: boolean
}): Promise<ExecutableTemplate> {
  const [tpl] = await db
    .select()
    .from(promptTemplates)
    .where(
      and(
        eq(promptTemplates.id, opts.templateId),
        eq(promptTemplates.enterpriseId, opts.enterpriseId),
      ),
    )
    .limit(1)
  if (!tpl) throw new Error("模板不存在")
  if (tpl.status !== "active") throw new Error("模板已归档，不可执行")
  if (opts.expectedType && tpl.type !== opts.expectedType) {
    throw new Error(`模板类型不匹配（需要 ${opts.expectedType}）`)
  }
  // 可见性校验
  if (tpl.visibility === "private" && tpl.ownerId !== opts.userId && !opts.isAdmin) {
    throw new Error("无权使用该私有模板")
  }
  if (!tpl.chatApiId) throw new Error("模板未关联对话模型")

  // 对话模型：平台预置（enterpriseId 为空）或本企业私有，且须为启用状态。
  // 仅 openai 兼容格式：本链路走 callChatApi（OpenAI 兼容专用），
  // claude/gemini/grok 格式仅供 /chat 交互对话使用。
  const [api] = await db
    .select()
    .from(chatApiConfigs)
    .where(
      and(
        eq(chatApiConfigs.id, tpl.chatApiId),
        eq(chatApiConfigs.isActive, true),
        eq(chatApiConfigs.formatType, "openai"),
        or(
          isNull(chatApiConfigs.enterpriseId),
          eq(chatApiConfigs.enterpriseId, opts.enterpriseId),
        ),
      ),
    )
    .limit(1)
  if (!api) throw new Error("模板关联的对话模型不可用")

  return {
    id: tpl.id,
    type: tpl.type,
    name: tpl.name,
    content: tpl.content,
    fissionCount: tpl.fissionCount,
    chatApi: {
      id: api.id,
      name: api.name,
      displayName: api.displayName,
      apiEndpoint: api.apiEndpoint,
      apiKeyEncrypted: api.apiKeyEncrypted,
      formatType: api.formatType,
      extraConfig: api.extraConfig,
      maxConcurrent: api.maxConcurrent,
      maxRetries: api.maxRetries,
      apiTimeout: api.apiTimeout,
    },
  }
}

/** 写工作台 API 日志 */
export async function logWorkspaceApi(opts: {
  enterpriseId: string
  userId: string
  apiType: "chat" | "image"
  apiConfigId?: string
  apiConfigName?: string
  workspaceTaskId?: string
  cardId?: string
  generationTaskId?: string
  requestParams?: string
  responseStatus?: "success" | "failure"
  responseBody?: string
  durationMs?: number
  errorMessage?: string
}): Promise<void> {
  await db.insert(workspaceApiLogs).values({
    enterpriseId: opts.enterpriseId,
    userId: opts.userId,
    apiType: opts.apiType,
    apiConfigId: opts.apiConfigId ?? null,
    apiConfigName: opts.apiConfigName ?? null,
    workspaceTaskId: opts.workspaceTaskId ?? null,
    cardId: opts.cardId ?? null,
    generationTaskId: opts.generationTaskId ?? null,
    requestParams: opts.requestParams?.slice(0, 2000) ?? null,
    responseStatus: opts.responseStatus ?? "success",
    responseBody: opts.responseBody?.slice(0, 1000) ?? null,
    durationMs: opts.durationMs ?? null,
    errorMessage: opts.errorMessage?.slice(0, 500) ?? null,
  })
}

/**
 * 提示词裂变：主题 → N 个子提示词。
 */
export async function fissionPrompts(opts: {
  config: ChatApiConfig
  theme: string
  count: number
  template: string
  enterpriseId: string
  userId: string
  workspaceTaskId?: string
  apiConfigId?: string
  apiConfigName?: string
  signal?: AbortSignal
}): Promise<string[]> {
  const userPrompt = fillTemplate(opts.template, {
    prompt: opts.theme,
    count: opts.count,
  })
  const startedAt = Date.now()
  try {
    const content = await callChatApi({
      config: opts.config,
      messages: [
        {
          role: "system",
          content:
            "你是专业的 AI 绘画提示词设计师。请按用户要求生成提示词，每条提示词独占一段，可用 === 分隔。",
        },
        { role: "user", content: userPrompt },
      ],
      signal: opts.signal,
    })
    const prompts = extractPrompts(content).slice(0, opts.count)
    await logWorkspaceApi({
      enterpriseId: opts.enterpriseId,
      userId: opts.userId,
      apiType: "chat",
      apiConfigId: opts.apiConfigId,
      apiConfigName: opts.apiConfigName,
      workspaceTaskId: opts.workspaceTaskId,
      requestParams: userPrompt.slice(0, 500),
      responseBody: content.slice(0, 1000),
      durationMs: Date.now() - startedAt,
    })
    return prompts.length > 0 ? prompts : [content.trim()].filter(Boolean)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await logWorkspaceApi({
      enterpriseId: opts.enterpriseId,
      userId: opts.userId,
      apiType: "chat",
      apiConfigId: opts.apiConfigId,
      apiConfigName: opts.apiConfigName,
      workspaceTaskId: opts.workspaceTaskId,
      requestParams: userPrompt.slice(0, 500),
      responseStatus: "failure",
      errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    throw err
  }
}

/** 旧拼写兼容 */
export const fissioPrompt = fissionPrompts

/**
 * 提取裂变：长文本 → N 个描述提示词。
 */
export async function extractPromptDescriptions(opts: {
  config: ChatApiConfig
  rawText: string
  template: string
  enterpriseId: string
  userId: string
  workspaceTaskId?: string
  apiConfigId?: string
  apiConfigName?: string
}): Promise<string[]> {
  const userPrompt = fillTemplate(opts.template, { prompt: opts.rawText })
  const startedAt = Date.now()
  try {
    const content = await callChatApi({
      config: opts.config,
      messages: [
        { role: "system", content: "你是一个文本提取助手，请按要求提取结构化提示词。" },
        { role: "user", content: userPrompt },
      ],
    })
    const prompts = extractPrompts(content)
    await logWorkspaceApi({
      enterpriseId: opts.enterpriseId,
      userId: opts.userId,
      apiType: "chat",
      apiConfigId: opts.apiConfigId,
      apiConfigName: opts.apiConfigName,
      workspaceTaskId: opts.workspaceTaskId,
      requestParams: userPrompt.slice(0, 500),
      responseBody: content.slice(0, 1000),
      durationMs: Date.now() - startedAt,
    })
    return prompts
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await logWorkspaceApi({
      enterpriseId: opts.enterpriseId,
      userId: opts.userId,
      apiType: "chat",
      apiConfigId: opts.apiConfigId,
      apiConfigName: opts.apiConfigName,
      workspaceTaskId: opts.workspaceTaskId,
      requestParams: userPrompt.slice(0, 500),
      responseStatus: "failure",
      errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    throw err
  }
}

/**
 * 批量替换提取：长文本 → [{cardIndex, prompt}]。
 */
export async function extractNumberedPromptReplacements(opts: {
  config: ChatApiConfig
  rawText: string
  template: string
  enterpriseId: string
  userId: string
  workspaceTaskId?: string
  apiConfigId?: string
  apiConfigName?: string
}): Promise<Array<{ cardIndex: number; prompt: string }>> {
  const userPrompt =
    fillTemplate(opts.template, { prompt: opts.rawText }) +
    '\n请仅返回 JSON 数组，数组项格式为 {"card_index": 数字编号, "prompt": "提示词"}。'
  const startedAt = Date.now()
  try {
    const content = await callChatApi({
      config: opts.config,
      messages: [
        { role: "system", content: "你是一个文本提取助手，请按要求返回纯 JSON。" },
        { role: "user", content: userPrompt },
      ],
    })
    const items = extractNumberedPrompts(content)
    await logWorkspaceApi({
      enterpriseId: opts.enterpriseId,
      userId: opts.userId,
      apiType: "chat",
      apiConfigId: opts.apiConfigId,
      apiConfigName: opts.apiConfigName,
      workspaceTaskId: opts.workspaceTaskId,
      requestParams: userPrompt.slice(0, 500),
      responseBody: content.slice(0, 1000),
      durationMs: Date.now() - startedAt,
    })
    return items
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await logWorkspaceApi({
      enterpriseId: opts.enterpriseId,
      userId: opts.userId,
      apiType: "chat",
      apiConfigId: opts.apiConfigId,
      apiConfigName: opts.apiConfigName,
      workspaceTaskId: opts.workspaceTaskId,
      requestParams: userPrompt.slice(0, 500),
      responseStatus: "failure",
      errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    throw err
  }
}

/**
 * 细化/重新生成提示词（单卡片同步）。
 */
export async function deepenPrompt(opts: {
  config: ChatApiConfig
  currentPrompt: string
  template: string
  templateType?: "deepen" | "regenerate"
  enterpriseId: string
  userId: string
  cardId?: string
  workspaceTaskId?: string
  apiConfigId?: string
  apiConfigName?: string
}): Promise<string> {
  const userPrompt = fillTemplate(opts.template, { prompt: opts.currentPrompt })
  const startedAt = Date.now()
  try {
    const content = await callChatApi({
      config: opts.config,
      messages: [
        { role: "system", content: "你是 AI 绘画提示词优化助手，请直接返回优化后的提示词。" },
        { role: "user", content: userPrompt },
      ],
    })
    const result = content.trim()
    await logWorkspaceApi({
      enterpriseId: opts.enterpriseId,
      userId: opts.userId,
      apiType: "chat",
      apiConfigId: opts.apiConfigId,
      apiConfigName: opts.apiConfigName,
      workspaceTaskId: opts.workspaceTaskId,
      cardId: opts.cardId,
      requestParams: userPrompt.slice(0, 500),
      responseBody: result.slice(0, 1000),
      durationMs: Date.now() - startedAt,
    })
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await logWorkspaceApi({
      enterpriseId: opts.enterpriseId,
      userId: opts.userId,
      apiType: "chat",
      apiConfigId: opts.apiConfigId,
      apiConfigName: opts.apiConfigName,
      workspaceTaskId: opts.workspaceTaskId,
      cardId: opts.cardId,
      requestParams: userPrompt.slice(0, 500),
      responseStatus: "failure",
      errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    throw err
  }
}

/**
 * 翻译提示词（中文 → 英文）。
 */
export async function translatePrompt(opts: {
  config: ChatApiConfig
  currentPrompt: string
  template: string
  enterpriseId: string
  userId: string
  cardId?: string
  workspaceTaskId?: string
  apiConfigId?: string
  apiConfigName?: string
}): Promise<string> {
  const userPrompt = fillTemplate(opts.template, { prompt: opts.currentPrompt })
  const startedAt = Date.now()
  try {
    const content = await callChatApi({
      config: opts.config,
      messages: [
        { role: "system", content: "你是翻译助手，将中文提示词翻译为英文，直接返回译文。" },
        { role: "user", content: userPrompt },
      ],
    })
    const result = content.trim()
    await logWorkspaceApi({
      enterpriseId: opts.enterpriseId,
      userId: opts.userId,
      apiType: "chat",
      apiConfigId: opts.apiConfigId,
      apiConfigName: opts.apiConfigName,
      workspaceTaskId: opts.workspaceTaskId,
      cardId: opts.cardId,
      requestParams: userPrompt.slice(0, 500),
      responseBody: result.slice(0, 1000),
      durationMs: Date.now() - startedAt,
    })
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await logWorkspaceApi({
      enterpriseId: opts.enterpriseId,
      userId: opts.userId,
      apiType: "chat",
      apiConfigId: opts.apiConfigId,
      apiConfigName: opts.apiConfigName,
      workspaceTaskId: opts.workspaceTaskId,
      cardId: opts.cardId,
      requestParams: userPrompt.slice(0, 500),
      responseStatus: "failure",
      errorMessage: msg,
      durationMs: Date.now() - startedAt,
    })
    throw err
  }
}

/**
 * 对话任务重试退避计算。
 *
 * base * 2^retryCount，封顶 cap；例如 base=1000ms、cap=60s：
 *   第 1 次重试 → 1s、第 2 次 → 2s、第 3 次 → 4s、第 4 次 → 8s … 最高 60s。
 * cron 调度器在扫描 queued 任务时会跳过 nextRetryAt 未到的行，从而实现指数退避。
 */
const CHAT_RETRY_BASE_MS = 1000
const CHAT_RETRY_CAP_MS = 60_000
const CHAT_DEFAULT_MAX_RETRIES = 3

function computeNextRetryAt(retryCount: number): Date {
  const delay = Math.min(CHAT_RETRY_BASE_MS * 2 ** retryCount, CHAT_RETRY_CAP_MS)
  return new Date(Date.now() + delay)
}

/**
 * 处理单个对话任务（chatTasks 行）：执行 LLM 调用并更新卡片/任务状态。
 * 供 chat 队列消费者调用。
 */
export async function processChatTask(opts: {
  chatTaskId: string
  enterpriseId: string
}): Promise<void> {
  const { chatTasks, promptCards } = await import("@/db/schema")
  const [task] = await db
    .select()
    .from(chatTasks)
    .where(eq(chatTasks.id, opts.chatTaskId))
    .limit(1)
  if (!task || task.status !== "queued") return

  // 原子抢占：UPDATE ... WHERE status='queued' RETURNING。
  // 并发消费者中只有一个能拿到返回行，其余拿到空数组即放弃，避免重复处理同一任务。
  const claimed = await db
    .update(chatTasks)
    .set({ status: "processing", startedAt: new Date(), nextRetryAt: null })
    .where(and(eq(chatTasks.id, opts.chatTaskId), eq(chatTasks.status, "queued")))
    .returning()
  if (claimed.length === 0) return

  // 在 try 外声明，使 catch 也能读取到已解析的 chatApi.maxRetries（模板解析本身失败时为 undefined）
  let tpl: ExecutableTemplate | undefined
  try {
    if (!task.templateId) throw new Error("对话任务缺少模板")
    const isAdmin = false // 队列处理不涉及 admin 判定，模板可见性已在入队时校验
    tpl = await getExecutableTemplate({
      templateId: task.templateId,
      enterpriseId: opts.enterpriseId,
      userId: task.userId,
      isAdmin,
    })

    const result = await deepenPrompt({
      config: tpl.chatApi,
      currentPrompt: task.originalPrompt,
      template: tpl.content,
      templateType: task.taskType === "regenerate" ? "regenerate" : "deepen",
      enterpriseId: opts.enterpriseId,
      userId: task.userId,
      cardId: task.cardId,
      workspaceTaskId: task.workspaceTaskId ?? undefined,
      apiConfigId: tpl.chatApi.id,
      apiConfigName: tpl.chatApi.name,
    })

    if (task.taskType === "translate") {
      await db
        .update(promptCards)
        .set({
          translatedPrompt: result,
          translationSourcePrompt: task.originalPrompt,
          translationStatus: "synced",
          translationTemplateId: task.templateId,
          updatedAt: new Date(),
        })
        .where(eq(promptCards.id, task.cardId))
    } else {
      // deepen / regenerate：更新主提示词，译文标记过期
      await db
        .update(promptCards)
        .set({
          prompt: result,
          translationStatus: "outdated",
          updatedAt: new Date(),
        })
        .where(eq(promptCards.id, task.cardId))
    }

    await db
      .update(chatTasks)
      .set({
        status: "completed",
        resultPrompt: result,
        completedAt: new Date(),
      })
      .where(eq(chatTasks.id, opts.chatTaskId))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 读取该任务所用 chatApi 配置的 maxRetries（DB 默认 3）。
    // 优先用本次已解析的模板 chatApi；模板解析失败时按 task.apiConfigId 回查配置。
    const maxRetries =
      tpl?.chatApi.maxRetries ?? (await resolveChatMaxRetries(task.apiConfigId))
    const shouldRetry = task.retryCount < maxRetries
    await db
      .update(chatTasks)
      .set({
        status: shouldRetry ? "queued" : "failed",
        retryCount: task.retryCount + 1,
        retryErrors: [...(task.retryErrors ?? []), msg],
        errorMessage: shouldRetry ? msg : `最终失败: ${msg}`,
        // 指数退避：重试时延迟可见，最终失败清空
        nextRetryAt: shouldRetry ? computeNextRetryAt(task.retryCount) : null,
        completedAt: shouldRetry ? undefined : new Date(),
      })
      .where(eq(chatTasks.id, opts.chatTaskId))
  }
}

/** 按 apiConfigId 回查对话 API 的 maxRetries（catch 分支兜底，模板解析失败时使用） */
async function resolveChatMaxRetries(
  apiConfigId: string | null,
): Promise<number> {
  if (!apiConfigId) return CHAT_DEFAULT_MAX_RETRIES
  const [api] = await db
    .select({ maxRetries: chatApiConfigs.maxRetries })
    .from(chatApiConfigs)
    .where(eq(chatApiConfigs.id, apiConfigId))
    .limit(1)
  return api?.maxRetries ?? CHAT_DEFAULT_MAX_RETRIES
}
