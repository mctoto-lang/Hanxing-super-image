import { createHmac, timingSafeEqual } from "node:crypto"
import { and, eq, inArray, sql } from "drizzle-orm"
import { NextResponse } from "next/server"
import { db } from "@/db/client"
import { generationTasks } from "@/db/schema"
import { loadMockupConfig } from "@/lib/mockup/settings"
import { syncMockupTask } from "@/server/services/mockup-service"

export const dynamic = "force-dynamic"

/**
 * PS-API 渲染任务终态回调（webhook 接收端）
 *
 * URL 携带企业 ID（?ent=<enterpriseId>，每企业在 PS-API 的 API Key 上配置
 * 本地址与配对的 webhookSecret）。验签 X-Render-Signature（HMAC-SHA256 对
 * 原始 body）通过后，按 payload.jobCode（= 本地任务 externalJobId）反查
 * 在途任务并触发一次即时同步——下载转存/退款完全复用 syncMockupTask，
 * worker/前端轮询通道保留为兜底（webhook 丢失不影响收敛）。
 *
 * 状态不信任 payload 内容：同步时以 PS-API 查询接口返回为准，伪造回调
 * 最多触发一次多余的状态查询，无法伪造结果。
 */
export async function POST(request: Request) {
  const enterpriseId = new URL(request.url).searchParams.get("ent") ?? ""
  if (!/^[0-9a-f-]{36}$/i.test(enterpriseId)) {
    return NextResponse.json({ ok: false, error: "bad ent" }, { status: 400 })
  }
  const cfg = await loadMockupConfig(enterpriseId)
  if (!cfg?.webhookSecret) {
    return NextResponse.json(
      { ok: false, error: "webhook not configured" },
      { status: 401 },
    )
  }

  const raw = await request.text()
  const signatureHeader = request.headers.get("x-render-signature") ?? ""
  const expected = `sha256=${createHmac("sha256", cfg.webhookSecret).update(raw).digest("hex")}`
  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ ok: false, error: "bad signature" }, { status: 401 })
  }

  let payload: { event?: string; jobCode?: string; status?: string }
  try {
    payload = JSON.parse(raw) as typeof payload
  } catch {
    return NextResponse.json({ ok: false, error: "bad payload" }, { status: 400 })
  }

  // 旧版 PS-API 的 payload 只有内部 jobId（cuid），无 jobCode → 无法定位
  // 本地任务；返回 200 避免触发上游无意义重试（轮询通道照常兜底）
  const jobCode = payload.jobCode?.trim()
  if (!jobCode) {
    return NextResponse.json({ ok: true, matched: 0 })
  }

  const tasks = await db
    .select({ id: generationTasks.id })
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.taskType, "mockup"),
        eq(generationTasks.enterpriseId, enterpriseId),
        inArray(generationTasks.status, ["queued", "processing"]),
        sql`${generationTasks.templateInfo}->>'externalJobId' = ${jobCode}`,
      ),
    )
    .limit(5)

  for (const t of tasks) {
    try {
      await syncMockupTask(t.id, { externalJobId: jobCode, enterpriseId })
    } catch {
      // 单任务同步失败忽略：worker/前端轮询兜底
    }
  }
  return NextResponse.json({ ok: true, matched: tasks.length })
}
