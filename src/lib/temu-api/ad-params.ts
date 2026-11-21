/**
 * 广告组接口（bg.glo.searchrec.ad.*）调用侧共享工具：productIdList 入参
 * 净化 + 按 appKey 聚合的限速 ctx 构造（workbench 与同步链路共用）。
 *
 * 官方入参为 LIST<INTEGER>：非数字/形变 ID 直接触发 230012000 bad query
 * params（2026-11-19 生产 MISS FIREE 案实测）。注意整批「纯数字但非本
 * mall」的 ID 同样报 230012000——那是 token 错绑/跨店脏行问题，非本函数
 * 可防（读路径错误文案另有提示）。演示层 DPID 字符串走 callTemuApi 的
 * demo 拦截不发网络，须原样透传（demo-api 按请求 productIdList 回数据）。
 */
import type { TemuCallContext } from "@/lib/temu-api/client"

export function toAdProductIdList(
  ids: readonly string[],
  isDemo: boolean,
): Array<number | string> {
  if (isDemo) return [...ids]
  const out: Array<number | string> = []
  const dropped: string[] = []
  for (const pid of ids) {
    // Number("") === 0、"1e3"、前导零等形变兜底：纯数字且回验一致才放行
    const n = Number(pid)
    if (!/^\d+$/.test(pid) || !Number.isSafeInteger(n) || String(n) !== pid) {
      dropped.push(pid)
      continue
    }
    out.push(n)
  }
  if (dropped.length > 0) {
    console.warn(
      `[temu-ads] 剔除非数字/形变 productId ${dropped.length} 个（官方 LIST<INTEGER> 校验会拒）: ` +
        `${dropped.slice(0, 5).join(", ")}${dropped.length > 5 ? " …" : ""}`,
    )
  }
  return out
}

/** 广告族接口（bg.glo.searchrec.ad.*）独立限速：rateKey 按 appKey 聚合——
 *  官方频控按应用计，每店 3qps 桶拦不住同应用多店全店扇出的跨店叠加
 *  （2026-11-21 生产 RoseBlanche 4000004 实证）；聚合后同应用在进程内令牌桶
 *  + Redis 跨进程闸门下全局串行 ≥1s。qps 必须 ≥1：TokenBucket capacity=qps，
 *  小于 1 永远凑不满一个令牌。 */
export function adsRateCtx(ctx: TemuCallContext): TemuCallContext {
  return { ...ctx, rateKey: `ads:${ctx.appKey}`, qps: 1 }
}
