import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

/**
 * 插件远程规则热更新端点（Temu Collector 每 30 分钟拉取）。
 * v1 返回空列表 = 不覆盖插件本地规则（规则经 tcUserRules 注入，优先级最高）。
 * 后续需要服务端下发规则时，在此按店铺返回规则数组即可。
 */
export async function GET() {
  return NextResponse.json(
    { rules: [] },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  )
}
