/* 只读探针（2026-11-12）：调价服务端过滤验证。
 * 实测 PA 版 bg.glo.full.adjust.price.page.query 返回 7000022（token 无该 API 权限，
 * 调价API组-PA 属「仅自研单独申请」），但 CN 版参数表同样记载全套过滤参数——
 * 本探针改验 CN 版 + 过滤参数是否真实可用（priceOrderSn / extCodes+extCodeType /
 * productName 模糊语义）+ 响应字段一致性。
 * 过滤用例优先取首查返回的真实行字段，避免「过滤正确但结果为空」误判。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-adjust-pa.ts */
try {
  process.loadEnvFile()
} catch {}

const STORE_NAME = "RoseBlanche"
const PA_ROUTER = "https://openapi.kuajingmaihuo.com/openapi/router"
const QUERY_TYPE = "bg.full.adjust.price.page.query"

type ProbeJson = {
  success?: boolean
  errorCode?: unknown
  errorMsg?: unknown
  result?: { list?: Array<Record<string, unknown>>; total?: unknown }
}

async function call(
  c: { appKey: string; appSecret: string; accessToken: string },
  type: string,
  data: Record<string, unknown>,
): Promise<{ status: number; text: string; json: ProbeJson | null }> {
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
  const text = await res.text()
  let json: ProbeJson | null = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, text, json }
}

function brief(j: ProbeJson | null): string {
  if (!j) return "(非 JSON)"
  if (j.success === false) return `失败 errorCode=${j.errorCode} ${j.errorMsg}`
  const list = j.result?.list
  const total = j.result?.total
  if (!Array.isArray(list)) return `成功 但无 list（result 键：${Object.keys(j.result ?? {})}）`
  const first = list[0]
  return `成功 total=${total} 本页 ${list.length} 行` +
    (first ? ` 首行键：${Object.keys(first).join(",")}` : "")
}

async function main() {
  const { eq } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")

  const [store] = await db.select().from(temuStores).where(eq(temuStores.name, STORE_NAME)).limit(1)
  const ctx = await getTemuCallContext(store)
  if ("error" in ctx) {
    console.log("ctx 失败:", ctx.error)
    process.exit(0)
  }
  const c = ctx as { appKey: string; appSecret: string; accessToken: string }

  // ① 基础查询：status=1（待供应商确认）；空则回落 status=2（调价成功）拿真实行
  let probeStatus = 1
  let r = await call(c, QUERY_TYPE, { status: probeStatus, pageNo: 1, pageSize: 10 })
  console.log(`\n[① 基础 status=${probeStatus}] ${brief(r.json)}`)
  if (r.json?.success === false) {
    console.log("   基础查询失败，停止后续用例。原文:", r.text.slice(0, 300))
    process.exit(0)
  }
  if (!Array.isArray(r.json?.result?.list) || r.json.result.list.length === 0) {
    probeStatus = 2
    r = await call(c, QUERY_TYPE, { status: probeStatus, pageNo: 1, pageSize: 10 })
    console.log(`[①-回落 status=${probeStatus}] ${brief(r.json)}`)
  }
  const first = r.json?.result?.list?.[0] as
    | { priceOrderSn?: string; skcExtCode?: string; productName?: string }
    | undefined
  if (!first) {
    console.log("   两种状态均无行——过滤用例改用假值（只验证参数被接受，不验证命中）")
  }

  // ② priceOrderSn 过滤
  const sn = first?.priceOrderSn ?? "PROBE-FAKE-SN"
  const r2 = await call(c, QUERY_TYPE, { status: probeStatus, pageNo: 1, pageSize: 10, priceOrderSn: [sn] })
  console.log(`\n[② priceOrderSn=[${sn}]] ${brief(r2.json)}`)
  await new Promise((s) => setTimeout(s, 800))

  // ③ extCodes + extCodeType=1（SKC 货号）
  const ext = first?.skcExtCode ?? "PROBE-FAKE-EXT"
  const r3 = await call(c, QUERY_TYPE, { status: probeStatus, pageNo: 1, pageSize: 10, extCodes: [ext], extCodeType: 1 })
  console.log(`\n[③ extCodes=[${ext}] extCodeType=1] ${brief(r3.json)}`)
  await new Promise((s) => setTimeout(s, 800))

  // ④ productName 关键词（取真实商品名前 12 字符验证模糊语义）
  const nameKw = first?.productName?.slice(0, 12) ?? "PROBE"
  const r4 = await call(c, QUERY_TYPE, { status: probeStatus, pageNo: 1, pageSize: 10, productName: nameKw })
  console.log(`\n[④ productName=${JSON.stringify(nameKw)}] ${brief(r4.json)}`)
  if (first && r4.json?.success !== false) {
    const n4 = r4.json?.result?.list?.length ?? 0
    console.log(`   模糊语义判定：截取前 12 字符命中 ${n4} 行（0 行=精确匹配，>0=模糊包含）`)
  }

  console.log("\n结论摘要：①基础查询 ②单号过滤 ③货号过滤 ④商品名模糊语义")
  process.exit(0)
}

void main()
