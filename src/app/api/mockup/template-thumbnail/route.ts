import { NextResponse } from "next/server"
import { getCurrentUserContext } from "@/lib/auth/session"
import { fetchTemplateThumbnail } from "@/lib/mockup/client"
import { loadMockupConfig } from "@/lib/mockup/settings"

/**
 * 模板缩略图代理
 *
 * 外部渲染服务的模板缩略图需要 API Key 才能访问，浏览器 <img> 无法直连；
 * 此处按当前企业的渲染服务配置代理拉取。外部无该模板/无缩略图时 404，
 * 前端降级为占位图标。
 *
 * 性能：模板缩略图按版本不可变，这里做进程内缓存 + 同模板并发去重，
 * 避免每次冷缓存 N 张图逐张打穿「认证 → 查配置 → 外部服务」完整链路；
 * 上游支持 ETag 时（PS-API 已升级）回源走 If-None-Match/304，并向浏览器
 * 透传 ETag 协商缓存。
 *
 * 缓存键按可见性身份分区：私有模板仅归属人/管理员可见，其他成员回源是
 * 404——若只按 templateId 缓存，归属人先请求会让无权成员命中缓存拿到图。
 */

interface CachedThumb {
  etag: string | null
  body: ArrayBuffer
  contentType: string
}

/** 缩略图可见性身份：管理员互斥共享（可见范围相同），普通用户按人隔离 */
interface ThumbViewer {
  id: string
  admin: boolean
}

const CACHE_MAX_ENTRIES = 200
/** 进程内 LRU（Map 插入序即新鲜度序）；缩略图按版本不可变，无失效问题 */
const cache = new Map<string, CachedThumb>()
/** 同模板同身份并发回源合并（in-flight Promise） */
const inflight = new Map<string, Promise<CachedThumb | null>>()

/**
 * 回源并发信号量（4）：首屏网格 20+ 张图同时冷缓存时削峰，
 * 避免瞬时打满 PS-API（API Key 有按分钟限流，超限返回 429 → 前端拿到 404）
 */
const MAX_UPSTREAM_CONCURRENCY = 4
let upstreamActive = 0
const upstreamWaiters: Array<() => void> = []

async function withUpstreamSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (upstreamActive >= MAX_UPSTREAM_CONCURRENCY) {
    await new Promise<void>((resolve) => upstreamWaiters.push(resolve))
  }
  upstreamActive++
  try {
    return await fn()
  } finally {
    upstreamActive--
    upstreamWaiters.shift()?.()
  }
}

function cacheKey(templateId: string, viewer: ThumbViewer): string {
  return `${templateId}:${viewer.admin ? "admin" : viewer.id}`
}

function cacheGet(key: string): CachedThumb | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  cache.delete(key)
  cache.set(key, hit)
  return hit
}

function cacheSet(key: string, entry: CachedThumb) {
  if (cache.has(key)) {
    cache.delete(key)
  }
  cache.set(key, entry)
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

async function fetchThumbIntoCache(
  templateId: string,
  enterpriseId: string,
  viewer: ThumbViewer,
): Promise<CachedThumb | null> {
  const cfg = await loadMockupConfig(enterpriseId)
  if (!cfg) return null
  const key = cacheKey(templateId, viewer)
  const cached = cache.get(key)
  try {
    // 非公开模板仅归属人/企业管理员可看缩略图（X-User-Id/X-User-Admin 透传）；
    // 信号量内执行，突发冷缓存时按 4 并发回源
    const upstream = await withUpstreamSlot(() =>
      fetchTemplateThumbnail(
        cfg,
        templateId,
        { id: viewer.id, admin: viewer.admin },
        {
          // 上游已升级支持协商缓存时命中 304，免传缩略图字节
          ifNoneMatch: cached?.etag ?? undefined,
        },
      ),
    )
    if (upstream.status === 304 && cached) return cached
    if (!upstream.ok || !upstream.body) return null
    const entry: CachedThumb = {
      etag: upstream.headers.get("etag"),
      body: await upstream.arrayBuffer(),
      contentType: upstream.headers.get("content-type") ?? "image/png",
    }
    cacheSet(key, entry)
    return entry
  } catch {
    return null
  }
}

export async function GET(request: Request) {
  const ctx = await getCurrentUserContext()
  if (!ctx?.user.enterpriseId) {
    return new NextResponse("unauthorized", { status: 401 })
  }

  const templateId = new URL(request.url).searchParams.get("templateId")
  // 外部模板 ID 实际为 cuid（文档写 tpl_ 前缀，实测无前缀），宽松放行字母数字
  if (!templateId || !/^[a-zA-Z0-9_-]{1,64}$/.test(templateId)) {
    return new NextResponse("bad request", { status: 400 })
  }
  const viewer: ThumbViewer = {
    id: ctx.user.id,
    admin:
      ctx.user.enterpriseRole === "owner" ||
      ctx.user.enterpriseRole === "admin",
  }
  const key = cacheKey(templateId, viewer)

  let entry = cacheGet(key)
  if (!entry) {
    // 并发去重：仅首个请求发起回源；finally 只清理自己注册的 Promise，
    // 避免后来者把仍在途的新 Promise 误删导致重复回源
    const existing = inflight.get(key)
    if (existing) {
      entry = (await existing) ?? undefined
    } else {
      const pending = fetchThumbIntoCache(templateId, ctx.user.enterpriseId, viewer)
      inflight.set(key, pending)
      try {
        entry = (await pending) ?? undefined
      } finally {
        if (inflight.get(key) === pending) inflight.delete(key)
      }
    }
    if (!entry) {
      return new NextResponse("not found", { status: 404 })
    }
  }

  // 向浏览器透传协商缓存（同一浏览器二访直接 304）
  if (entry.etag && request.headers.get("if-none-match") === entry.etag) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: entry.etag,
        "Cache-Control": "private, max-age=600",
      },
    })
  }

  return new NextResponse(entry.body, {
    headers: {
      "Content-Type": entry.contentType,
      "Cache-Control": "private, max-age=600",
      ...(entry.etag ? { ETag: entry.etag } : {}),
    },
  })
}
