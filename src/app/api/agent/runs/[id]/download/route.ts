import { NextResponse } from "next/server"
import { Readable } from "node:stream"
import { ZipArchive } from "archiver"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import { agentRuns } from "@/db/schema"
import { requireEnterpriseContext } from "@/lib/auth/session"
import { checkModuleAccess } from "@/lib/auth/permissions"
import { loadStorageConfig, toInternalCosFetchUrl } from "@/lib/storage/config"
import { isPlatformStorageUrl } from "@/lib/storage/reference-url"
import { signUploadToken } from "@/lib/storage/upload-token"
import { readBodyBounded } from "@/lib/net/read-body-bounded"
import { getTarotDeliverablesAction } from "@/server/actions/agent-template"

export const dynamic = "force-dynamic"

/** 并发拉图数（每张整包缓冲，峰值内存 ≈ 并发 × 单图体积） */
const FETCH_CONCURRENCY = 4
/** 单文件回源超时与大小上限（防内网慢响应/超大响应占住内存） */
const FETCH_TIMEOUT_MS = 30_000
const MAX_FILE_BYTES = 64 * 1024 * 1024

/**
 * 交付物 ZIP 打包下载（compose 阶段下载中心）：
 * 服务端流式 archiver —— 响应立即返回，成品卡 + 套件资产边取边写入
 * （本站 /uploads 附短时效令牌，COS 按配置改写内网域名回源）。
 * 单张拉取失败不中断打包，记入 manifest.json 的 errors 清单。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  let ctx
  try {
    ctx = await requireEnterpriseContext()
  } catch (err) {
    const msg = err instanceof Error ? err.message : ""
    return NextResponse.json(
      { ok: false, error: msg || "未登录" },
      { status: msg.startsWith("UNAUTHORIZED") ? 401 : 403 },
    )
  }
  if (checkModuleAccess(ctx, "agent")) {
    return NextResponse.json({ ok: false, error: "无权访问 AI Agent 模块" }, { status: 403 })
  }

  // 归属与权限校验在 action 内完成（enterpriseId + userId 双过滤）
  const deliverables = await getTarotDeliverablesAction(id).catch((err: unknown) => {
    throw new Error(err instanceof Error ? err.message : "项目不存在或无权访问")
  })
  if (deliverables.files.length === 0) {
    return NextResponse.json({ ok: false, error: "尚无可下载的交付物" }, { status: 404 })
  }

  const [run] = await db
    .select({ title: agentRuns.title })
    .from(agentRuns)
    .where(eq(agentRuns.id, id))
  const zipBaseName = (run?.title ?? `agent-${id.slice(0, 8)}`).replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 60)

  const cfg = await loadStorageConfig()
  const fetchOne = async (url: string): Promise<Buffer> => {
    // 防 SSRF：库内 URL 同样只允许平台可信存储（应用自身 /uploads 或 COS 桶），
    // 非可信地址不发起请求，记入 manifest 的 errors 清单
    if (!(await isPlatformStorageUrl(url))) {
      throw new Error("非平台存储地址，已拒绝回源")
    }
    const fetchUrl = toInternalCosFetchUrl(new URL(signUploadToken(url)), cfg)
    const resp = await fetch(fetchUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!resp.ok) throw new Error(`回源 ${resp.status}`)
    return readBodyBounded(resp, MAX_FILE_BYTES)
  }

  const zip = new ZipArchive({ zlib: { level: 6 } })
  const errors: string[] = []
  let cursor = 0
  const pullWorker = async () => {
    while (cursor < deliverables.files.length) {
      const file = deliverables.files[cursor++]!
      try {
        zip.append(await fetchOne(file.url), { name: file.filename })
      } catch (err) {
        errors.push(`${file.filename}（${err instanceof Error ? err.message : "拉取失败"}）`)
      }
    }
  }

  // 打包流水线后台推进：响应流先行返回，archiver 边收边写
  void (async () => {
    try {
      await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, pullWorker))
      const manifest = {
        exportedAt: new Date().toISOString(),
        runId: id,
        total: deliverables.totalCount,
        ready: deliverables.files.length,
        files: deliverables.files.map((f) => ({ name: f.filename, title: f.title, kind: f.kind })),
        errors,
      }
      zip.append(Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"), { name: "manifest.json" })
      await zip.finalize()
    } catch (err) {
      zip.destroy(err instanceof Error ? err : new Error(String(err)))
    }
  })()

  return new NextResponse(Readable.toWeb(zip) as ReadableStream<Uint8Array>, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipBaseName}.zip"; filename*=UTF-8''${encodeURIComponent(`${zipBaseName}.zip`)}`,
      "Cache-Control": "no-store",
    },
  })
}
