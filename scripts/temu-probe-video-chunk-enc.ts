/* 探针（2026-11-12）：galerie upload_init 报 3000000「content type not supported」——
 * 验证是请求编码问题（multipart → urlencoded/JSON）还是参数问题。
 * 网关 sign 复用项目内 callTemuApi；只打 init（无文件、无挂载副作用，会话不 complete 即废弃）。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-video-chunk-enc.ts */
try {
  process.loadEnvFile()
} catch {}

const STORE_NAME = "RoseBlanche"
const INIT_URL = "https://openapi-b-partner.temu.com/api/galerie/large_file/v1/video/upload_init"

async function main() {
  const { eq } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { callTemuApi } = await import("../src/lib/temu-api/client")

  const [store] = await db.select().from(temuStores).where(eq(temuStores.name, STORE_NAME)).limit(1)
  const ctx = await getTemuCallContext(store)
  if ("error" in ctx) {
    console.log("ctx 失败:", ctx.error)
    process.exit(0)
  }
  const signEnv = await callTemuApi<{ sign?: unknown }>("bg.goods.video.upload.sign.get.global", {}, ctx)
  const sign = String(signEnv.result?.sign ?? "")
  console.log(`sign 长度=${sign.length}`)
  if (!sign) process.exit(0)

  // 形态 A：multipart/form-data（当前路由实现——已知 400 3000000）
  {
    const fd = new FormData()
    fd.append("create_media", "true")
    fd.append("content_type", "video/mp4")
    fd.append("sign", sign)
    const res = await fetch(INIT_URL, { method: "POST", body: fd })
    console.log(`[A multipart] HTTP ${res.status} → ${(await res.text()).slice(0, 200)}`)
  }
  await new Promise((s) => setTimeout(s, 1000))
  // 形态 B：application/x-www-form-urlencoded
  {
    const body = new URLSearchParams({ create_media: "true", content_type: "video/mp4", sign })
    const res = await fetch(INIT_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })
    console.log(`[B urlencoded] HTTP ${res.status} → ${(await res.text()).slice(0, 200)}`)
  }
  await new Promise((s) => setTimeout(s, 1000))
  // 形态 C：JSON
  {
    const res = await fetch(INIT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ create_media: true, content_type: "video/mp4", sign }),
    })
    console.log(`[C json] HTTP ${res.status} → ${(await res.text()).slice(0, 200)}`)
  }
  process.exit(0)
}
void main()
