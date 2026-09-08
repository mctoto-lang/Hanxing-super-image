import { NextResponse } from "next/server"
import { and, desc, eq, inArray } from "drizzle-orm"
import { zip } from "fflate"
import { db } from "@/db/client"
import { cardImages, promptCards, workspaceTasks } from "@/db/schema"
import { auth } from "@/lib/auth/config"
import { getExportTicket } from "@/server/services/export-ticket"
import {
  resolveCardDisplayImage,
  sanitizeFilenamePart,
} from "@/lib/workspace/helpers"
import { isPlatformStorageUrl } from "@/lib/storage/reference-url"
import { signUploadToken } from "@/lib/storage/upload-token"

/**
 * 工作台导出下载（手册 M5，1:1 对齐旧项目 /api/workspace/export-ticket 消费端）
 *
 * 消费 createExportTicketAction 生成的票据 → 拉取任务下选中图片 → 打包 ZIP 返回。
 * 票据 2 分钟过期，一次性消费，且绑定创建人（session 校验一致）。
 * 票据逻辑从 services/export-ticket 导入——route handler 不依赖 "use server"
 * actions 模块（避免拖入 auth/next-auth 整条依赖链；auth 本身在此直接使用，
 * 集成测试对 "@/lib/auth/config" 做 mock）。
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

  // 票据绑定创建人：仅本人可消费（proxy 已挡未登录，这里再校验身份一致）
  const session = await auth()
  if (!session?.user?.id || session.user.id !== t.userId) {
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
    // SSRF 防护：卡片图片 URL 中 uploaded 来源可由用户写入（写入侧已做
    // 归属校验），服务端二次拉取前仍强制 host 白名单（应用自身 / COS 桶），
    // 防止历史脏数据或新绕过路径借导出通道读取内网资源并打进 ZIP
    if (!(await isPlatformStorageUrl(img.imageUrl))) {
      console.warn(
        `[workspace/export] 跳过非平台存储图片（card=${card.id}）`,
      )
      continue
    }
    const idx = String(card.cardIndex).padStart(2, "0")
    const filename = `${taskName}-${idx}.${format}`
    fetchTasks.push(
      (async () => {
        try {
          // 本站 /uploads URL 附短时效令牌（服务端 fetch 无会话 cookie）
          const resp = await fetch(signUploadToken(img.imageUrl!), {
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
