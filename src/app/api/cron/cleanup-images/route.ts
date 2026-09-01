import { NextResponse } from "next/server"
import { and, asc, gt, isNotNull, lt } from "drizzle-orm"
import { db } from "@/db/client"
import { generationTasks, conversations } from "@/db/schema"
import { env } from "@/lib/env"
import { safeEqual } from "@/lib/crypto"
import { getStorage } from "@/lib/storage"
import { loadImageRetentionConfig } from "@/lib/storage/config"

/**
 * 过期图片清理（手册 §10.5，配合双桶 + category）
 *
 * 由宿主机 cron 定时触发（建议每天一次）。安全：CRON_SECRET Bearer 守卫
 *（常量时间比较，防时序攻击），与 process-queue 一致。
 *
 * 策略：
 * - 按 system_setting 的保留天数，删除超过保留期的对象（参考图 / 生成图 / 会话缩略图）。
 * - 仅删对象，**不删 DB 中的 URL** → 前端 SmartImage 捕获 404 显示「图片已过期」占位。
 * - 删除幂等（对象已不存在视为成功）。
 * - config 类图（logo / 模型图标 / 模板图）不在本清理范围，永不删除。
 *
 * 分页：按 id 升序 + 游标循环处理全部积压（旧实现 limit(1000) 无排序无游标，
 * 积压超一批时每轮只清任意子集，旧行可能永远轮不到）；单次运行设批数上限，
 * 剩余由下次 cron 继续（确定性排序保证推进）。
 *
 * 注：腾讯云 COS 生命周期规则（按 ref/、gen/ 前缀）是删对象的主路径；
 * 本端点为应用侧按系统设置强制清理的备份，二者任一生效即可。
 */
const DAY_MS = 24 * 60 * 60 * 1000
const BATCH_LIMIT = 1000
/** 单次运行最多处理的批次（防积压极大时单次运行超时） */
const MAX_BATCHES = 10

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization")
  if (
    !env.CRON_SECRET ||
    !authHeader ||
    !safeEqual(authHeader, `Bearer ${env.CRON_SECRET}`)
  ) {
    return new NextResponse("unauthorized", { status: 401 })
  }

  const retention = await loadImageRetentionConfig()
  const storage = await getStorage()

  let scannedTasks = 0
  let scannedConvos = 0
  let referenceDeleted = 0
  let generateDeleted = 0
  let thumbDeleted = 0

  // 参考图：任务完成超过 referenceRetainDays → 删除 referenceImages 对象
  if (retention.referenceRetainDays > 0) {
    const threshold = new Date(
      Date.now() - retention.referenceRetainDays * DAY_MS,
    )
    let cursor: string | null = null
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const rows = await db
        .select({
          id: generationTasks.id,
          referenceImages: generationTasks.referenceImages,
        })
        .from(generationTasks)
        .where(
          and(
            isNotNull(generationTasks.completedAt),
            lt(generationTasks.completedAt, threshold),
            cursor ? gt(generationTasks.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(generationTasks.id))
        .limit(BATCH_LIMIT)
      scannedTasks += rows.length
      const urls = rows.flatMap((r) => r.referenceImages ?? []).filter(Boolean)
      referenceDeleted += await storage.deleteObjects(urls)
      if (rows.length < BATCH_LIMIT) break
      cursor = rows[rows.length - 1]!.id
    }
  }

  // 生成图：任务完成超过 generateRetainDays → 删除 resultImages 对象 + 会话缩略图
  if (retention.generateRetainDays > 0) {
    const threshold = new Date(
      Date.now() - retention.generateRetainDays * DAY_MS,
    )
    let cursor: string | null = null
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const rows = await db
        .select({
          id: generationTasks.id,
          resultImages: generationTasks.resultImages,
        })
        .from(generationTasks)
        .where(
          and(
            isNotNull(generationTasks.completedAt),
            lt(generationTasks.completedAt, threshold),
            cursor ? gt(generationTasks.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(generationTasks.id))
        .limit(BATCH_LIMIT)
      scannedTasks += rows.length
      const urls = rows.flatMap((r) => r.resultImages ?? []).filter(Boolean)
      generateDeleted += await storage.deleteObjects(urls)
      if (rows.length < BATCH_LIMIT) break
      cursor = rows[rows.length - 1]!.id
    }

    let convoCursor: string | null = null
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const convoRows = await db
        .select({
          id: conversations.id,
          lastImageThumb: conversations.lastImageThumb,
        })
        .from(conversations)
        .where(
          and(
            isNotNull(conversations.lastImageThumb),
            lt(conversations.updatedAt, threshold),
            convoCursor ? gt(conversations.id, convoCursor) : undefined,
          ),
        )
        .orderBy(asc(conversations.id))
        .limit(BATCH_LIMIT)
      scannedConvos += convoRows.length
      const thumbUrls = convoRows
        .map((r) => r.lastImageThumb)
        .filter((u): u is string => Boolean(u))
      thumbDeleted += await storage.deleteObjects(thumbUrls)
      if (convoRows.length < BATCH_LIMIT) break
      convoCursor = convoRows[convoRows.length - 1]!.id
    }
  }

  return NextResponse.json({
    ok: true,
    retention,
    scannedTasks,
    scannedConvos,
    referenceDeleted,
    generateDeleted,
    thumbDeleted,
  })
}
