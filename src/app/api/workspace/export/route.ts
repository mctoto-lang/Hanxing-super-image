import { NextResponse } from "next/server"
import { and, desc, eq, inArray } from "drizzle-orm"
import { zip } from "fflate"
import { db } from "@/db/client"
import { cardImages, promptCards, workspaceTasks } from "@/db/schema"
import { getExportTicket } from "@/server/services/export-ticket"
import {
  resolveCardDisplayImage,
  sanitizeFilenamePart,
} from "@/lib/workspace/helpers"

/**
 * 工作台导出下载（手册 M5，1:1 对齐旧项目 /api/workspace/export-ticket 消费端）
 *
 * 消费 createExportTicketAction 生成的票据 → 拉取任务下选中图片 → 打包 ZIP 返回。
 * 票据 2 分钟过期，一次性消费。票据逻辑从 services/export-ticket 导入——
 * route handler 不依赖 "use server" actions 模块（避免拖入 auth 依赖链）。
 */

export async function GET(request: Request) {
  try {
    return await exportZip(request)
  } catch (err) {
    // 兜底：带错误文本的 500（未捕获异常返回空体会让浏览器只显示
    // 「当前无法处理此请求」，无法定位问题）
    console.error("[workspace/export] 导出失败:", err)
    const msg = err instanceof Error ? err.message : String(err)
    return new NextResponse(`导出失败: ${msg}`, { status: 500 })
  }
}

async function exportZip(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const ticket = searchParams.get("ticket")
  if (!ticket) {
    return new NextResponse("missing ticket", { status: 400 })
  }

  const t = await getExportTicket(ticket)
  if (!t) {
    return new NextResponse("ticket expired or invalid", { status: 410 })
  }

  // 拉取任务（校验归属）
  const [task] = await db
    .select()
    .from(workspaceTasks)
    .where(
      and(
        eq(workspaceTasks.id, t.taskId),
        eq(workspaceTasks.enterpriseId, t.enterpriseId),
      ),
    )
    .limit(1)
  if (!task) {
    return new NextResponse("task not found", { status: 404 })
  }

  // 拉取卡片（按 cardIndex 排序）
  const cardConds = [
    eq(promptCards.taskId, t.taskId),
    eq(promptCards.enterpriseId, t.enterpriseId),
  ]
  if (t.cardIds && t.cardIds.length > 0) {
    cardConds.push(inArray(promptCards.id, t.cardIds))
  }
  const cards = await db
    .select({
      id: promptCards.id,
      cardIndex: promptCards.cardIndex,
      selectedImageId: promptCards.selectedImageId,
    })
    .from(promptCards)
    .where(and(...cardConds))
    .orderBy(promptCards.cardIndex)

  // 拉取每张卡片的选中图片
  const cardIds = cards.map((c) => c.id)
  if (cardIds.length === 0) {
    return new NextResponse("no cards to export", { status: 404 })
  }

  const images = await db
    .select({
      id: cardImages.id,
      cardId: cardImages.cardId,
      imageUrl: cardImages.imageUrl,
      format: cardImages.format,
      status: cardImages.status,
      isSelected: cardImages.isSelected,
    })
    .from(cardImages)
    .where(
      and(
        inArray(cardImages.cardId, cardIds),
        eq(cardImages.enterpriseId, t.enterpriseId),
        eq(cardImages.status, "completed"),
      ),
    )
    .orderBy(desc(cardImages.createdAt))

  // 每张卡片取一张展示图（与卡片正面展示一致：selectedImageId → isSelected
  // → 最新已完成；images 已按 createdAt 降序）
  const imagesByCard = new Map<string, typeof images>()
  for (const img of images) {
    const list = imagesByCard.get(img.cardId)
    if (list) list.push(img)
    else imagesByCard.set(img.cardId, [img])
  }

  // 并发抓取图片二进制
  const fetchTasks: Promise<{
    filename: string
    data: Uint8Array
  } | null>[] = []
  const taskName = sanitizeFilenamePart(task.title || "workspace-export")
  const format = t.format === "png" ? "png" : "jpg"

  for (const card of cards) {
    const img = resolveCardDisplayImage(
      card,
      imagesByCard.get(card.id) ?? [],
    )
    if (!img?.imageUrl) continue
    const idx = String(card.cardIndex).padStart(2, "0")
    const filename = `${taskName}-${idx}.${format}`
    fetchTasks.push(
      (async () => {
        try {
          const resp = await fetch(img.imageUrl!, {
            signal: AbortSignal.timeout(30_000),
          })
          if (!resp.ok) return null
          const buf = new Uint8Array(await resp.arrayBuffer())
          return { filename, data: buf }
        } catch {
          return null
        }
      })(),
    )
  }

  const results = await Promise.all(fetchTasks)
  const valid = results.filter((r): r is { filename: string; data: Uint8Array } => r !== null)
  if (valid.length === 0) {
    return new NextResponse("no images available to export", { status: 404 })
  }

  // 打包 ZIP（fflate）
  const zipData: Record<string, Uint8Array> = {}
  for (const r of valid) {
    zipData[r.filename] = r.data
  }

  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    zip(zipData, (err, data) => {
      if (err) reject(err)
      else resolve(data)
    })
  })

  return new NextResponse(Buffer.from(zipped), {
    headers: {
      "Content-Type": "application/zip",
      // HTTP 头只允许 ByteString（latin1），中文文件名直接塞 filename 会抛
      // TypeError（→ 500 空体）。用 RFC 5987：filename*=UTF-8''<百分号编码>，
      // 并给不支持 filename* 的老浏览器一个纯 ASCII 兜底名。
      "Content-Disposition": `attachment; filename="${asciiFallbackName(taskName)}.zip"; filename*=UTF-8''${encodeURIComponent(taskName)}.zip`,
      "Cache-Control": "no-store",
    },
  })
}

/** Content-Disposition 的 ASCII 兜底文件名：剔除非 ASCII 与危险字符 */
function asciiFallbackName(name: string): string {
  return (
    name.replace(/[^\x20-\x7e]/g, "").replace(/["\\;]/g, "").trim() ||
    "workspace-export"
  )
}
