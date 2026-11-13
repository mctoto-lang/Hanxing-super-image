/* 探针（2026-11-12）：视频上传全链路验证——修正 docs §8.12 旧结论「主图视频链路不通」。
 * 旧探针败因：bg.goods.big.video.upload.result.get.global 应传 vid（文件上传后返回），
 * 此前传 sign/goodsId 三形态均 120000001。本次按文档站「视频上传流程」(149198083286)
 * 全链路：① sign.get.global（无入参即可）→ ② galerie 直传端点（不走网关/不需
 * access_token，multipart: file+create_media+sign）→ ③ result.get.global{vid} 轮询 →
 * ④ （--submit 时）edit.pictures.submit 挂主图视频位（测试品，有副作用）。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-video-upload.ts [--submit] */
try {
  process.loadEnvFile()
} catch {}

const STORE_NAME = "RoseBlanche"
const PRODUCT_ID = 4666287147
const VIDEO_PATH = ".zcode/tmp/probe-video.mp4"
const PA_ROUTER = "https://openapi-b-partner.temu.com/openapi/router"
const GALERIE_SINGLE = "https://openapi-b-partner.temu.com/api/galerie/v1/store_video"

const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms))

type ProbeJson = {
  success?: boolean
  errorCode?: unknown
  errorMsg?: unknown
  result?: Record<string, unknown>
}

async function gatewayCall(
  c: { appKey: string; appSecret: string; accessToken: string },
  type: string,
  data: Record<string, unknown>,
): Promise<ProbeJson> {
  const { signTemuRequest } = await import("../src/lib/temu-api/sign")
  const body: Record<string, unknown> = {
    type,
    timestamp: Math.floor(Date.now() / 1000),
    app_key: c.appKey,
    data_type: "JSON",
    access_token: c.accessToken,
    ...data,
  }
  body.sign = signTemuRequest(body, c.appSecret)
  const res = await fetch(PA_ROUTER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function main() {
  const doSubmit = process.argv.includes("--submit")
  const { eq } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const fs = await import("node:fs")

  const [store] = await db.select().from(temuStores).where(eq(temuStores.name, STORE_NAME)).limit(1)
  const ctx = await getTemuCallContext(store)
  if ("error" in ctx) {
    console.log("ctx 失败:", ctx.error)
    process.exit(0)
  }
  const c = ctx as { appKey: string; appSecret: string; accessToken: string }

  // ① sign.get.global（此前对照探针实证：空参即可返回 sign）
  const signRes = await gatewayCall(c, "bg.goods.video.upload.sign.get.global", {})
  const sign = signRes?.result?.sign as string | undefined
  console.log(`[① sign.get] success=${signRes?.success} sign 长度=${sign?.length ?? 0}`)
  if (!sign) {
    console.log("   sign 获取失败，停止。原文:", JSON.stringify(signRes).slice(0, 300))
    process.exit(0)
  }

  // ② galerie 单请求直传（≤20MB）：multipart file+create_media+sign，无需 access_token
  const buf = fs.readFileSync(VIDEO_PATH)
  console.log(`[② store_video] 上传 ${buf.length} 字节 → ${GALERIE_SINGLE}`)
  const fd = new FormData()
  fd.append("file", new Blob([new Uint8Array(buf)], { type: "video/mp4" }), "probe-flower.mp4")
  fd.append("create_media", "true")
  fd.append("sign", sign)
  const upRes = await fetch(GALERIE_SINGLE, { method: "POST", body: fd })
  const upText = await upRes.text()
  console.log(`   HTTP ${upRes.status} → ${upText.slice(0, 400)}`)
  let vid: string | undefined
  try {
    const upJson = JSON.parse(upText)
    vid = upJson?.vid ?? upJson?.result?.vid ?? upJson?.data?.vid
  } catch {}
  if (!vid) {
    console.log("   未解析到 vid，停止（检查响应信封后调整解析）")
    process.exit(0)
  }
  console.log(`   vid = ${vid}`)

  // ③ result.get.global {vid} 轮询（转码需要时间；120000012=处理中类错误码，继续等）
  let video: { videoUrl?: string; coverUrl?: string; width?: number; height?: number } | null = null
  for (let i = 1; i <= 15; i += 1) {
    await sleep(i === 1 ? 4000 : 7000)
    const r = await gatewayCall(c, "bg.goods.big.video.upload.result.get.global", { vid })
    const res3: Record<string, unknown> = r?.result ?? {}
    console.log(
      `[③ result.get 第${i}次] success=${r?.success} errorCode=${r?.errorCode} result=${JSON.stringify(res3).slice(0, 260)}`,
    )
    if (r?.success && res3.videoUrl) {
      video = res3 as { videoUrl?: string; coverUrl?: string; width?: number; height?: number }
      break
    }
    // 120000012 = 转码/处理中（继续轮询）；其他错误码跳出
    if (r?.success === false && r?.errorCode !== 120000012) break
  }
  if (!video?.videoUrl) {
    console.log("   转码未完成或无 videoUrl（可能仍在处理——vid 已有效，链路②③已通）")
  }

  // ④ edit.pictures.submit 挂主图视频位（--submit 才执行，有副作用：测试品挂视频）
  if (doSubmit) {
    if (!video?.videoUrl) {
      console.log("[④ submit] 跳过：无转码结果")
    } else {
      const videoReq = {
        vid,
        coverUrl: video.coverUrl ?? "",
        videoUrl: video.videoUrl,
        width: video.width ?? 0,
        height: video.height ?? 0,
      }
      const r4 = await gatewayCall(c, "bg.glo.goods.edit.pictures.submit", {
        productId: PRODUCT_ID,
        productCarouseVideoReqList: [videoReq],
      })
      console.log(
        `[④ edit.pictures.submit 主图视频位] success=${r4?.success} errorCode=${r4?.errorCode} ${r4?.errorMsg ?? ""} 原文=${JSON.stringify(r4).slice(0, 300)}`,
      )
    }
  } else {
    console.log("\n（未传 --submit：④ 挂载提交未执行）")
  }
  console.log("\n结论：①sign ②直传 ③转码查询 ④挂载（可选）")
  process.exit(0)
}

void main()
