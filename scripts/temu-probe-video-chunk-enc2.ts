/* 探针（2026-11-12）二段：upload_part / upload_complete 编码形态。
 * 已实证 upload_init 只收 JSON；store_video（单请求）收 multipart。
 * 本探针用 5MB 零字节分片走完 part→complete（产物 vid 不挂载任何商品，无害废弃）。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-video-chunk-enc2.ts */
try {
  process.loadEnvFile()
} catch {}

const STORE_NAME = "RoseBlanche"
const BASE = "https://openapi-b-partner.temu.com/api/galerie/large_file/v1/video"

async function main() {
  const { eq } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { callTemuApi } = await import("../src/lib/temu-api/client")

  const [store] = await db.select().from(temuStores).where(eq(temuStores.name, STORE_NAME)).limit(1)
  const ctx = await getTemuCallContext(store)
  const signEnv = await callTemuApi<{ sign?: unknown }>("bg.goods.video.upload.sign.get.global", {}, ctx)
  const sign = String(signEnv.result?.sign ?? "")
  if (!sign) {
    console.log("sign 获取失败")
    process.exit(0)
  }

  // init（JSON，已实证）
  const initRes = await fetch(`${BASE}/upload_init`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ create_media: true, content_type: "video/mp4", sign }),
  })
  const initJson = (await initRes.json()) as { sign?: string }
  console.log(`[init JSON] HTTP ${initRes.status} chunkSign长度=${initJson.sign?.length ?? 0}`)
  const chunkSign = initJson.sign ?? ""
  if (!chunkSign) process.exit(0)

  // part A：multipart（文档含 part_file File 字段，预期 multipart）
  const PART_BYTES = 5 * 1024 * 1024
  {
    const fd = new FormData()
    fd.append("part_file", new Blob([new Uint8Array(PART_BYTES)], { type: "application/octet-stream" }), "part-1")
    fd.append("part_num", "1")
    fd.append("sign", chunkSign)
    const res = await fetch(`${BASE}/upload_part`, { method: "POST", body: fd })
    console.log(`[part multipart] HTTP ${res.status} → ${(await res.text()).slice(0, 200)}`)
  }

  // complete A：JSON
  {
    const res = await fetch(`${BASE}/upload_complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sign: chunkSign }),
    })
    console.log(`[complete JSON] HTTP ${res.status} → ${(await res.text()).slice(0, 300)}`)
  }
  process.exit(0)
}
void main()
