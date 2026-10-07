/**
 * Agent 对话（LLM）三层并发槽位（模型 / 权限组 / 企业）
 *
 * 与生图队列（task-queue.acquireImageSlot）同款语义、独立计数键
 * （hanxing:agentllm:*），覆盖 callLlmJson 的全部 Agent LLM 调用
 * （澄清/初稿/终稿/评审/改写）；网页对话 SSE 路由的 chat-concurrency
 * 不受影响（各自独立键）。
 *
 * 上限来源（≤0 = 该维度不限）：
 * - 模型（跨企业全局）：chat_api_config.max_concurrent（对话模型「最大并发」）
 * - 权限组：permission_group.max_concurrent（与生图共用同列）
 * - 企业：enterprise.chat_max_concurrent（企业「对话并发上限」）
 *
 * 槽位为图片槽位的同款模式：Lua 原子三条件获取（多 worker 安全），
 * TTL 兜底自愈（worker 崩溃不漏槽），500ms 轮询等待。
 */
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises, permissionGroups, users } from "@/db/schema"
import { redis } from "@/lib/redis"
import { ACQUIRE_SLOT_LUA, RELEASE_SLOT_LUA } from "@/lib/queue/task-queue"
import type { AgentLlmContext, ChatModelRow } from "./llm"

/** 轮询间隔（200ms：槽位释放到被拾取的平均延迟减半，排队吞吐更高） */
const SLOT_POLL_MS = 200
/** 等待超过该时长打一条 warn（限流排队可观测，不中断） */
const WARN_AFTER_MS = 30_000

function entKey(enterpriseId: string) {
  return `hanxing:agentllm:ent:${enterpriseId}:concurrent`
}
function groupKey(groupId: string) {
  return `hanxing:agentllm:group:${groupId}:concurrent`
}
function modelKey(modelId: string) {
  return `hanxing:agentllm:model:${modelId}:concurrent`
}

/** 对话槽位限额（按 ctx 惰性加载一次并缓存；运行期视为不变） */
export interface AgentLlmLimits {
  groupId: string | null
  groupMaxConcurrent: number
  entChatMaxConcurrent: number
}

async function loadLlmLimits(ctx: AgentLlmContext): Promise<AgentLlmLimits> {
  if (ctx.llmLimits) return ctx.llmLimits
  const [userRow] = await db
    .select({ groupId: users.groupId })
    .from(users)
    .where(eq(users.id, ctx.run.userId))
  let groupMax = 0
  if (userRow?.groupId) {
    const [groupRow] = await db
      .select({ maxConcurrent: permissionGroups.maxConcurrent })
      .from(permissionGroups)
      .where(eq(permissionGroups.id, userRow.groupId))
    groupMax = groupRow?.maxConcurrent ?? 0
  }
  const [entRow] = await db
    .select({ chatMaxConcurrent: enterprises.chatMaxConcurrent })
    .from(enterprises)
    .where(eq(enterprises.id, ctx.run.enterpriseId))
  const limits: AgentLlmLimits = {
    groupId: userRow?.groupId ?? null,
    groupMaxConcurrent: groupMax,
    entChatMaxConcurrent: entRow?.chatMaxConcurrent ?? 0,
  }
  ctx.llmLimits = limits
  return limits
}

const evalLua = (script: string, numKeys: number, ...args: unknown[]) =>
  (redis.eval as unknown as (s: string, n: number, ...a: unknown[]) => Promise<number | string>)(
    script,
    numKeys,
    ...args,
  )

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * 解析三层对话槽位的有效并发上限（模型 / 权限组 / 企业 chat）：
 * ≤0 的维度视为不限；三个维度全不限时返回 null（由调用方决定兜底值）。
 * 与 withAgentLlmSlot 同款限额来源（ctx 缓存，运行期视为不变）。
 */
export async function resolveAgentLlmSlotLimit(
  ctx: AgentLlmContext,
  model: ChatModelRow,
): Promise<number | null> {
  const limits = await loadLlmLimits(ctx)
  const modelMax = model.maxConcurrent ?? 0
  const candidates = [modelMax, limits.groupMaxConcurrent, limits.entChatMaxConcurrent].filter(
    (value) => value > 0,
  )
  return candidates.length > 0 ? Math.min(...candidates) : null
}

/**
 * 在三层对话槽位内执行 fn：获取（排队等待）→ 执行 → 释放。
 * 三个维度全部不限时直通（零 Redis 开销）。等待期间不设硬超时（与生图
 * 槽位一致：排队语义），超过 30s 打一条 warn 便于观测限流瓶颈。
 */
export async function withAgentLlmSlot<T>(
  ctx: AgentLlmContext,
  model: ChatModelRow,
  fn: () => Promise<T>,
): Promise<T> {
  const limits = await loadLlmLimits(ctx)
  const modelMax = model.maxConcurrent ?? 0
  if (modelMax <= 0 && limits.groupMaxConcurrent <= 0 && limits.entChatMaxConcurrent <= 0) {
    return await fn()
  }

  // 键序与生图槽位 Lua 约定一致：[企业, 模型, 权限组]；无组时指向企业占位键（max≤0 不读写）
  const keys = [
    entKey(ctx.run.enterpriseId),
    modelKey(model.id),
    limits.groupId ? groupKey(limits.groupId) : entKey(ctx.run.enterpriseId),
  ]
  const started = Date.now()
  let warned = false
  // 槽位 TTL（秒）须 ≥ 槽内单次调用预算（callLlmText：max(120, taskTimeout||300)）+ 60s
  // 余量：过短会在长调用期间过期清零、三层并发上限被突破（对齐生图槽位 slotTtlSec
  // 同款推导）；每次 ACQUIRE 均续期，崩溃后仍自动过期自愈
  const slotTtlSec = Math.max(120, (model.taskTimeout || 300) + 60)
  for (;;) {
    const ok = await evalLua(
      ACQUIRE_SLOT_LUA,
      3,
      ...keys,
      limits.entChatMaxConcurrent,
      modelMax,
      limits.groupMaxConcurrent,
      slotTtlSec,
    )
    if (Number(ok) === 1) break
    if (!warned && Date.now() - started > WARN_AFTER_MS) {
      console.warn(
        `[agent-llm] 等待对话并发槽位超 ${Math.round((Date.now() - started) / 1000)}s（模型「${model.displayName}」上限 ${modelMax}，企业对话 ${limits.entChatMaxConcurrent}，权限组 ${limits.groupMaxConcurrent}）`,
      )
      warned = true
    }
    await sleep(SLOT_POLL_MS)
  }
  try {
    return await fn()
  } finally {
    await evalLua(RELEASE_SLOT_LUA, keys.length, ...keys)
  }
}
