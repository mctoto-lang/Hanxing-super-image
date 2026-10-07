/**
 * Agent 模板任务队列消费核心（塔罗模板流程；经典全流程已下线）
 *
 * 与触发方式解耦：被独立 worker 进程（scripts/worker.ts）周期调用。每轮：
 *   1. 崩溃恢复：running 且心跳（updated_at）超时 > 15 分钟的模板运行退回
 *      queued（pendingAction 保留）等待重试；produce_cards 在途卡牌复位回
 *      pending（batch 只拾取 pending，不复位会永久卡住）；
 *   2. 原子认领模板任务（仅 queued + 模板 + pendingAction 非空）→
 *      executeTemplateAction；成功后除 produce_cards（生产执行器自行收口：
 *      小样→waiting_human / 全套→completed 等）外统一复位 waiting_human；
 *      失败保留 pendingAction 供前端一键重试。
 *
 * 注意：produce_cards 一次执行可能持续数分钟（78 张多轮 LLM + 生图），
 * 本轮调用会阻塞后续轮询——企业间并行已缓解，v1 接受该取舍。
 */
import { and, asc, eq, inArray, isNotNull, lt, ne, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { agentAssets, agentEvents, agentRunItems, agentRuns } from "@/db/schema"
import { executeTemplateAction } from "@/server/services/agent/template-steps"
import type { ProcessResult } from "@/lib/queue/processor"

/**
 * running 心跳超时阈值（ms）：超过视为 worker 崩溃遗留。
 * 须大于单个节点组内最长无心跳时长：produce_cards 心跳只在每层节点组前打，
 * 组内生图受模型 taskTimeout 预算约束（默认 300s，表单可配更大），生图槽位
 * TTL 也按 taskTimeout+300 续期——取 15 分钟覆盖默认值 3 倍，避免执行中的
 * 任务被 worker 的独立恢复循环（scripts/worker.ts 每 60s 调用）误判 stale
 * 复位、同一张卡双执行双扣费。taskTimeout 理论无上限：配置远超 15 分钟的
 * 模型仍有误判可能，彻底修复需在生图/LLM 等待循环内逐张心跳。
 */
const STALE_RUNNING_MS = 15 * 60 * 1000

/** 每轮最多认领的 queued 任务数 */
const MAX_RUNS_PER_POLL = 10

/**
 * 崩溃恢复：模板运行心跳超时（> STALE_RUNNING_MS）→ 退回 queued 重试
 * （pendingAction 保留）。produce_cards 在途卡牌复位回 pending（batch
 * 只拾取 pending，不复位会永久卡住）；asset_gen 的「评审中」行标记废弃。
 *
 * 独立导出：produce_cards 在 processAgentQueueOnce 内同步执行可达数十分钟，
 * 阻塞后续轮询——worker 用独立定时通道调用本函数，让其他企业的崩溃恢复
 * 与新任务认领不被长任务卡死。
 */
export async function recoverStaleAgentRuns(): Promise<void> {
  const now = new Date()
  const staleTemplateRuns = await db
    .update(agentRuns)
    .set({ status: "queued", updatedAt: now })
    .where(
      and(
        eq(agentRuns.status, "running"),
        isNotNull(agentRuns.template),
        lt(agentRuns.updatedAt, new Date(now.getTime() - STALE_RUNNING_MS)),
      ),
    )
    .returning({ id: agentRuns.id, pendingAction: agentRuns.pendingAction })
  for (const run of staleTemplateRuns) {
    if (run.pendingAction?.kind === "produce_cards") {
      const reset = await db
        .update(agentRunItems)
        .set({ status: "pending", updatedAt: now })
        .where(
          and(
            eq(agentRunItems.runId, run.id),
            inArray(agentRunItems.status, ["drafting", "generating", "reviewing"]),
          ),
        )
        .returning({ id: agentRunItems.id })
      if (reset.length > 0) {
        await db.insert(agentEvents).values({
          runId: run.id,
          action: "start",
          status: "warn",
          detail: `检测到生产任务心跳超时（worker 重启或中断），复位 ${reset.length} 张在途卡牌继续执行`,
        })
      }
    }
    if (run.pendingAction?.kind === "asset_gen") {
      // 资产生成的「评审中」行是 worker 内的中过渡态：崩溃后重试会插入新行，
      // 旧行若不处理将永久停在 reviewing（面板显示「AI 评审中」假状态）——
      // 统一标记 rejected（meta 附中断原因，保留分数线索）
      const staleReviewing = await db
        .update(agentAssets)
        .set({
          meta: sql`${agentAssets.meta} || ${JSON.stringify({
            status: "rejected",
            interrupted: true,
          })}::jsonb`,
        })
        .where(
          and(
            eq(agentAssets.runId, run.id),
            sql`${agentAssets.meta} ->> 'status' = 'reviewing'`,
          ),
        )
        .returning({ id: agentAssets.id })
      if (staleReviewing.length > 0) {
        await db.insert(agentEvents).values({
          runId: run.id,
          action: "start",
          status: "warn",
          detail: `检测到资产生成任务心跳超时，${staleReviewing.length} 项「评审中」记录已标记废弃（重试将重新生成）`,
        })
      }
    }
    await db.insert(agentEvents).values({
      runId: run.id,
      action: "resume",
      status: "warn",
      detail: "检测到模板任务心跳超时（worker 重启或中断），已重新排队重试",
    })
  }
}

export async function processAgentQueueOnce(): Promise<ProcessResult[]> {
  // ── 1. 崩溃恢复（认领前先扫；worker 另有独立定时通道，见 recoverStaleAgentRuns） ──
  await recoverStaleAgentRuns()

  const now = new Date()

  // ── 2. 原子认领模板任务（仅 queued + 模板 + 待执行动作） ──
  // UPDATE 不支持 LIMIT：先选候选 id，再以 status = queued 条件更新，
  // 多 worker 并发时只有一方能把同一行从 queued 改为 running。
  const templateCandidates = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.status, "queued"),
        isNotNull(agentRuns.template),
        isNotNull(agentRuns.pendingAction),
      ),
    )
    .orderBy(asc(agentRuns.updatedAt))
    .limit(MAX_RUNS_PER_POLL)
  const templateClaims = templateCandidates.length
    ? await db
        .update(agentRuns)
        .set({ status: "running", updatedAt: now })
        .where(
          and(
            inArray(agentRuns.id, templateCandidates.map((c) => c.id)),
            eq(agentRuns.status, "queued"),
          ),
        )
        .returning({ id: agentRuns.id, enterpriseId: agentRuns.enterpriseId, pendingAction: agentRuns.pendingAction })
    : []

  const results: ProcessResult[] = []

  if (templateClaims.length > 0) {
    // 模板任务：按企业分组（企业内串行，防同 run 并发重入）
    const byEnterprise = new Map<string, string[]>()
    for (const r of templateClaims) {
      const list = byEnterprise.get(r.enterpriseId) ?? []
      list.push(r.id)
      byEnterprise.set(r.enterpriseId, list)
    }

    await Promise.all(
      [...byEnterprise.entries()].map(async ([enterpriseId, runIds]) => {
        let processed = 0
        let failed = 0
        for (const claim of templateClaims.filter((c) => runIds.includes(c.id))) {
          const runId = claim.id
          try {
            await executeTemplateAction(runId)
            if (claim.pendingAction?.kind === "produce_cards") {
              // 生产任务自行收口（小样 → waiting_human / 全套 → completed 等）：
              // 只清 pendingAction/error，不改状态；异常路径残留 running 时
              // 防御性退回 waiting_human 等用户重试。
              // 清 pendingAction 排除 queued：执行期间用户若已排队新动作
              // （status=queued + 新 pendingAction），不能把它抹掉——否则
              // run 变成 queued+pendingAction=null，任何一方都不会再消费，永久卡死。
              await db
                .update(agentRuns)
                .set({ pendingAction: null, error: null, updatedAt: new Date() })
                .where(and(eq(agentRuns.id, runId), ne(agentRuns.status, "queued")))
              await db
                .update(agentRuns)
                .set({ status: "waiting_human", updatedAt: new Date() })
                .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "running")))
            } else {
              // 复位带 status=running 守卫：执行期间被并发置成其它状态
              // （如用户已排队新动作）时不覆盖，避免吞掉新动作或把非 running
              // 状态硬拉回 waiting_human
              await db
                .update(agentRuns)
                .set({ status: "waiting_human", pendingAction: null, error: null, updatedAt: new Date() })
                .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "running")))
            }
            processed++
          } catch (err) {
            failed++
            const message = err instanceof Error ? err.message : String(err)
            // fail 事件由 executeTemplateAction 内按角色补发；这里只复位 run 终态。
            // pendingAction 保留：前端据此展示失败的是哪一步，并可一键重试。
            // 同样带 running 守卫：若用户已排队新动作（queued），交给下一轮执行
            await db
              .update(agentRuns)
              .set({ status: "waiting_human", error: message, updatedAt: new Date() })
              .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "running")))
            console.error(`[agent-queue] 模板任务 ${runId} 失败:`, message)
          }
        }
        results.push({ enterpriseId, processed, failed })
      }),
    )
  }

  return results
}
