import { NextResponse } from "next/server"
import { and, eq } from "drizzle-orm"

import { db } from "@/db/client"
import { temuStores } from "@/db/schema/temu"
import { getCurrentEnterpriseScope, requireEnterpriseContext } from "@/lib/auth/session"
import { MODULE_LABELS } from "@/lib/modules"
import { apiError, withRouteHandler } from "@/lib/api/route-helpers"
import { callTemuApi, type TemuCallContext } from "@/lib/temu-api/client"
import { getTemuCallContext } from "@/server/services/temu-sync"

/**
 * TEMU 视频直传转发端点（换视频功能，2026-11-12 探针全通）。
 *
 * 官方链路（文档站「视频上传流程」149198083286 + 探针实证）：
 * - sign：bg.goods.video.upload.sign.get.global（走 PA 网关，空参即可）
 * - ≤20MB 单请求：POST /api/galerie/v1/store_video（multipart file+create_media+sign）
 *   → 平铺响应 {url, etag, vid}
 * - >20MB 分片：upload_init（**JSON** {create_media, content_type, sign}）→ {sign(分片标记)}
 *   → upload_part（multipart part_file+part_num+sign）× N → upload_complete（**JSON**
 *   {sign, content_md5?}）→ {vid}；分片规则：5MB ≤ 块 ≤ 20MB 且为 5MB 整数倍，末块不限
 *   （init/complete 仅收 application/json——multipart/urlencoded 报 3000000，2026-11-12 探针）
 * - galerie 端点不走网关、不需 access_token，仅凭 sign 鉴权
 *
 * 本路由只做鉴权 + sign 获取 + 转发（浏览器直连 galerie 有跨域限制）；
 * 演示店铺短路返回虚拟 vid 不出网。错误体为纯文本（route-helpers 口径）。
 */

const GALERIE_BASE = "https://openapi-b-partner.temu.com/api/galerie"
/** 单请求/单分片硬上限（官方分片规则上限 20MB） */
const MAX_PART_BYTES = 20 * 1024 * 1024
/** 演示模式虚拟视频（CC0 样例，仅预览用） */
const DEMO_VIDEO_URL = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"

function demoVid() {
  return `demo-vid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 通用鉴权：登录 + temu 页面权限 + 店铺归属（同换图 action 口径） */
async function guardStore(
  storeId: string,
): Promise<{ ok: false; error: string } | { ok: true; store: typeof temuStores.$inferSelect }> {
  const ctx0 = await requireEnterpriseContext()
  if (!ctx0.canAccess("temu")) {
    return { ok: false, error: `当前账号没有「${MODULE_LABELS.temu}」页面权限，无法执行该操作` }
  }
  const { enterpriseId } = getCurrentEnterpriseScope(ctx0)
  const [store] = await db
    .select()
    .from(temuStores)
    .where(and(eq(temuStores.id, storeId), eq(temuStores.enterpriseId, enterpriseId)))
    .limit(1)
  if (!store) return { ok: false, error: "店铺不存在或无权访问" }
  if (!store.enabled) return { ok: false, error: "店铺已停用" }
  return { ok: true, store }
}

/** 取上传 sign（PA 网关 sign.get.global；演示店铺由 demo 拦截层返回虚拟 sign） */
async function fetchUploadSign(ctx: TemuCallContext) {
  const envelope = await callTemuApi<{ sign?: unknown }>(
    "bg.goods.video.upload.sign.get.global",
    {},
    ctx,
  )
  const sign = typeof envelope.result?.sign === "string" ? envelope.result.sign : ""
  if (!sign) throw new Error("官方未返回上传 sign")
  return sign
}

/** galerie 转发（带文件的单请求/分片走 multipart；init/complete 无文件字段走 JSON——
 * 2026-11-12 探针实证：init 用 multipart/urlencoded 均报 3000000 content type not
 * supported，仅 application/json 被接受；part 的 part_file 是 File 字段收 multipart）。
 * 官方错误体也是 JSON，透传给前端定位 */
async function postGalerie(
  path: string,
  body: FormData | string,
  contentType?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {}
  if (contentType) headers["content-type"] = contentType
  const res = await fetch(`${GALERIE_BASE}${path}`, { method: "POST", headers, body })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`官方上传端点返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }
  if (!res.ok || json.error_code != null) {
    throw new Error(
      `官方上传端点失败（HTTP ${res.status}${json.error_code != null ? ` ${json.error_code}` : ""}）：${String(json.error_msg ?? text).slice(0, 200)}`,
    )
  }
  return json
}

export const POST = withRouteHandler(async (request: Request) => {
  const form = await request.formData()
  const op = String(form.get("op") ?? "")
  const storeId = String(form.get("store") ?? "")

  const g = await guardStore(storeId)
  if (!g.ok) return apiError(g.error, 403)
  const { store } = g

  // 演示店铺：虚拟链路（sign 由 demo 拦截层返回，galerie 不出网）
  if (store.isDemo) {
    switch (op) {
      case "single":
        return NextResponse.json({ ok: true, vid: demoVid(), url: DEMO_VIDEO_URL })
      case "init":
        return NextResponse.json({ ok: true, uploadSign: "demo-upload-sign" })
      case "part":
        return NextResponse.json({ ok: true, uploadedPartNum: Number(form.get("partNum") ?? 1) })
      case "complete":
        return NextResponse.json({ ok: true, vid: demoVid(), url: DEMO_VIDEO_URL })
      default:
        return apiError("未知操作", 400)
    }
  }

  const ctx = await getTemuCallContext(store)
  if ("error" in ctx) return apiError(ctx.error, 400)

  try {
    if (op === "single") {
      const file = form.get("file")
      if (!(file instanceof File)) return apiError("缺少视频文件", 400)
      if (file.size <= 0) return apiError("视频文件为空", 400)
      if (file.size > MAX_PART_BYTES) return apiError("超过单请求 20MB 上限，请走分片上传", 413)
      const sign = await fetchUploadSign(ctx)
      const fd = new FormData()
      fd.append("file", file, file.name || "video.mp4")
      fd.append("create_media", "true")
      fd.append("sign", sign)
      const md5 = form.get("contentMd5")
      if (typeof md5 === "string" && md5) fd.append("content_md5", md5)
      const json = await postGalerie("/v1/store_video", fd)
      const vid = typeof json.vid === "string" ? json.vid : ""
      if (!vid) return apiError(`官方未返回 vid：${JSON.stringify(json).slice(0, 200)}`, 502)
      return NextResponse.json({ ok: true, vid, url: typeof json.url === "string" ? json.url : "" })
    }

    if (op === "init") {
      const contentType = String(form.get("contentType") ?? "")
      if (!contentType.startsWith("video/")) return apiError("仅支持视频文件", 415)
      const sign = await fetchUploadSign(ctx)
      const json = await postGalerie(
        "/large_file/v1/video/upload_init",
        JSON.stringify({ create_media: true, content_type: contentType, sign }),
        "application/json",
      )
      const uploadSign = typeof json.sign === "string" ? json.sign : ""
      if (!uploadSign) return apiError(`官方未返回分片上传 sign：${JSON.stringify(json).slice(0, 200)}`, 502)
      return NextResponse.json({ ok: true, uploadSign })
    }

    if (op === "part") {
      const uploadSign = String(form.get("uploadSign") ?? "")
      const partNum = String(form.get("partNum") ?? "")
      if (!uploadSign || !partNum) return apiError("缺少分片上传 sign 或分片编号", 400)
      const file = form.get("file")
      if (!(file instanceof File)) return apiError("缺少分片文件", 400)
      if (file.size > MAX_PART_BYTES) return apiError("分片超过 20MB 上限（须为 5MB 整数倍）", 413)
      const fd = new FormData()
      fd.append("part_file", file, `part-${partNum}`)
      fd.append("part_num", partNum)
      fd.append("sign", uploadSign)
      const md5 = form.get("contentMd5")
      if (typeof md5 === "string" && md5) fd.append("content_md5", md5)
      const json = await postGalerie("/large_file/v1/video/upload_part", fd)
      return NextResponse.json({ ok: true, uploadedPartNum: json.uploaded_part_num })
    }

    if (op === "complete") {
      const uploadSign = String(form.get("uploadSign") ?? "")
      if (!uploadSign) return apiError("缺少分片上传 sign", 400)
      const md5 = form.get("contentMd5")
      const payload: Record<string, unknown> = { sign: uploadSign }
      if (typeof md5 === "string" && md5) payload.content_md5 = md5
      const json = await postGalerie(
        "/large_file/v1/video/upload_complete",
        JSON.stringify(payload),
        "application/json",
      )
      const vid = typeof json.vid === "string" ? json.vid : ""
      if (!vid) return apiError(`官方未返回 vid：${JSON.stringify(json).slice(0, 200)}`, 502)
      return NextResponse.json({ ok: true, vid, url: typeof json.url === "string" ? json.url : "" })
    }

    return apiError("未知操作", 400)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[temu-video-upload]", msg)
    return apiError(msg.slice(0, 300), 502)
  }
})
