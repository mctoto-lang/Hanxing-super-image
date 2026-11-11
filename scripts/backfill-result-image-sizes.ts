/**
 * 存量生成任务回填 result_image_sizes（worker 转存时探测尺寸的存量补齐）。
 *
 * 背景：worker 现已在转存时从 buffer 探测像素尺寸写入
 * generation_task.result_image_sizes（与 result_images 按位置对齐）。
 * 本脚本为上线前的存量任务补齐：逐图请求 COS 数据万象 imageInfo
 * 元数据接口（只返回宽高/格式 JSON，不下载图片字节，几乎零流量）。
 *
 * - 只处理 result_image_sizes IS NULL 且 result_images 非空的任务；
 * - 404（已被生命周期删除）/ 403（未开通数据万象）/ 非 myqcloud URL → 该图
 *   记 null，但整列仍落库（下次重跑自动跳过，幂等）；
 * - 超时/网络抖动/5xx 等瞬时失败 → 退避重试，仍失败则整任务本轮跳过
 *   不落库（下次重跑再探测），绝不把瞬时失败永久写成 null；
 * - 按 id keyset 分批取数（每批 500 条），不一次性物化全部存量行；
 * - 建议在 COS 生命周期规则删除旧图之前跑一次（图片删除后再也无法探测）。
 *
 * 用法：
 *   npx tsx scripts/backfill-result-image-sizes.ts            # dry-run：只统计
 *   npx tsx scripts/backfill-result-image-sizes.ts --apply    # 实际写入
 *   npx tsx scripts/backfill-result-image-sizes.ts --apply --limit=100
 */

import { pathToFileURL } from "node:url"

// 先加载本地 .env（开发），生产靠容器注入 env；必须在动态 import 之前执行
try {
  process.loadEnvFile()
} catch {}

/** 并发探测数：imageInfo 极轻，适度并发即可 */
const CONCURRENCY = 6
/** keyset 分批大小：单批物化上限（id + result_images jsonb），控制内存与单查询时长 */
const BATCH_SIZE = 500
/** 瞬时失败（超时/网络/5xx）退避重试次数 */
const TRANSIENT_RETRIES = 2

type Size = { width: number; height: number } | null

/** 单图探测结果：miss=永久无尺寸（可落库 null）；transient=瞬时失败（不落库，重跑再探测） */
export type ProbeResult =
  | { kind: "hit"; size: { width: number; height: number } }
  | { kind: "miss" }
  | { kind: "transient"; reason: string }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 探测单个 COS URL 的尺寸（走数据万象 ?imageInfo 元数据接口）。
 * 仅 404/403/非 myqcloud URL 记 miss（永久 null）；超时/网络/5xx 退避重试
 * 后仍失败则返回 transient，由调用方跳过该任务不落库（重跑可再探测）。
 */
export async function probeImageUrl(
  url: string,
  retryDelayMs = 1_000,
): Promise<ProbeResult> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { kind: "miss" } // 非法 URL 无从探测
  }
  if (!u.hostname.endsWith(".myqcloud.com")) {
    return { kind: "miss" } // 非 COS 直链（如本地 /uploads）无从探测
  }
  u.search = "?imageInfo"

  let reason = "unknown"
  for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs * attempt) // 退避重试
    try {
      const resp = await fetch(u, { signal: AbortSignal.timeout(15_000) })
      if (resp.ok) {
        // imageInfo 的 width/height 是字符串（"1254"），Number() 归一
        const data = (await resp.json()) as {
          width?: unknown
          height?: unknown
        }
        const width = Number(data.width)
        const height = Number(data.height)
        if (
          Number.isFinite(width) &&
          Number.isFinite(height) &&
          width > 0 &&
          height > 0
        ) {
          return { kind: "hit", size: { width, height } }
        }
        return { kind: "miss" } // 服务端已应答但无有效宽高
      }
      if (resp.status === 404 || resp.status === 403) {
        // 404=对象已被生命周期删除；403=数据万象未开通 —— 永久，记 null
        return { kind: "miss" }
      }
      reason = `HTTP ${resp.status}` // 429/5xx 等：瞬时，重试
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err) // 超时/网络抖动：瞬时，重试
    }
  }
  return { kind: "transient", reason }
}

async function main() {
  const apply = process.argv.includes("--apply")
  const limitArg = process.argv.find((a) => a.startsWith("--limit="))
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : null

  const { db } = await import("../src/db/client")
  const { generationTasks } = await import("../src/db/schema")
  const { and, asc, eq, gt, isNotNull, isNull, sql } = await import("drizzle-orm")

  const pendingWhere = and(
    isNull(generationTasks.resultImageSizes),
    isNotNull(generationTasks.resultImages),
    sql`${generationTasks.resultImages} != '[]'::jsonb`,
  )

  // 先轻量 count（不物化 jsonb 列），供进度展示与 --limit 截断
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(generationTasks)
    .where(pendingWhere)
  const total = limit && limit > 0 ? Math.min(limit, count) : count
  console.log(
    `${apply ? "【APPLY】" : "【DRY-RUN】"}待回填任务 ${total} 条${limit ? `（--limit=${limit}）` : ""}`,
  )
  if (total === 0) return

  let done = 0
  let skippedTransient = 0
  let probedImages = 0
  let hitImages = 0
  let lastId: string | undefined

  // keyset 分批（id 升序游标）：每批至多 BATCH_SIZE 行，避免全量进内存
  while (done < total) {
    const batchLen = Math.min(BATCH_SIZE, total - done)
    const rows = await db
      .select({
        id: generationTasks.id,
        resultImages: generationTasks.resultImages,
      })
      .from(generationTasks)
      .where(
        lastId ? and(pendingWhere, gt(generationTasks.id, lastId)) : pendingWhere,
      )
      .orderBy(asc(generationTasks.id))
      .limit(batchLen)
    if (rows.length === 0) break
    lastId = rows[rows.length - 1]!.id

    // 小并发池逐任务处理：任务内图片串行（单任务图少），任务间并发
    const queue = [...rows]
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const row = queue.shift()
        if (!row) return
        const images = (row.resultImages as string[] | null) ?? []
        const sizes: Size[] = []
        let transient = false
        for (const url of images) {
          const r = await probeImageUrl(url)
          sizes.push(r.kind === "hit" ? r.size : null)
          probedImages++
          if (r.kind === "hit") hitImages++
          else if (r.kind === "transient") transient = true
        }
        if (transient) {
          // 瞬时失败不落库：保留 result_image_sizes IS NULL，下次重跑再探测
          skippedTransient++
        } else if (apply) {
          await db
            .update(generationTasks)
            .set({ resultImageSizes: sizes })
            .where(eq(generationTasks.id, row.id))
        }
        done++
        if (done % 50 === 0 || done === total) {
          console.log(
            `进度 ${done}/${total}（探测图片 ${probedImages}，命中尺寸 ${hitImages}）`,
          )
        }
      }
    })
    await Promise.all(workers)
    if (rows.length < batchLen) break // 已取尽
  }

  console.log(
    `完成：${done} 任务、探测 ${probedImages} 图、命中尺寸 ${hitImages}（${apply ? "已写库" : "dry-run 未写库"}）` +
      (skippedTransient > 0
        ? `；${skippedTransient} 任务因瞬时失败本轮跳过未落库，重跑可再探测`
        : ""),
  )
}

// 仅直接执行时跑 main（被单测 import 时不触发）。
// postgres 连接池持有事件循环引用，跑完显式退出（与 backfill-last-login.ts 同）。
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .then(() => {
      process.exit(0)
    })
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
