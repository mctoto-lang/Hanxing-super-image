/**
 * TEMU 采集完整性校验：对 DB 落库数据做逐源统计，与插件侧 expected（可选传入）对照。
 * 用法：npx tsx --env-file=.env scripts/verify-temu-capture.ts
 * 可选：SWEEP_EXPECTED='{"sales-overview":{"captured":596,"expected":596},...}' 传入插件 tcSweepState.captured
 */
import { sql } from "drizzle-orm"
import { db } from "@/db/client"

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

async function rows<T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> {
  const r = (await db.execute(q)) as unknown as { rows: T[] }
  return r.rows ?? (r as unknown as T[])
}

async function main() {
  const today = startOfToday().toISOString()
  const out: string[] = []

  const p = (label: string, v: unknown) => out.push(`${label}: ${v}`)

  // ---- temu_product（商品列表 + 生命周期两源合并） ----
  const [prod] = await rows<{ total: string; with_detail: string; on_sale: string }>(sql`
    select count(*)::text as total,
           count(*) filter (where skc_status is not null or lifecycle_status is not null or category is not null or supplier_price is not null)::text as with_detail,
           count(*) filter (where skc_status = 11)::text as on_sale
    from temu_product`)
  p("temu_product 总SKC", prod.total)
  p("temu_product 有详情字段", prod.with_detail)
  p("temu_product 在售(skcStatus=11)", prod.on_sale)
  const lcDist = await rows<{ lifecycle_status: string; c: string }>(sql`
    select coalesce(lifecycle_status, '—null—') as lifecycle_status, count(*)::text as c
    from temu_product group by 1 order by 2::int desc limit 12`)
  p("lifecycleStatus 分布", JSON.stringify(lcDist.map((r) => `${r.lifecycle_status}:${r.c}`)))
  const fieldFill = await rows<{ f: string; c: string }>(sql`
    select 'supplierPrice' as f, count(supplier_price)::text as c from temu_product
    union all select 'category', count(category)::text from temu_product
    union all select 'mainImageUrl', count(main_image_url)::text from temu_product
    union all select 'productSn', count(product_sn)::text from temu_product
    union all select 'totalSalesVolume', count(total_sales_volume)::text from temu_product`)
  p("字段填充", JSON.stringify(fieldFill.map((r) => `${r.f}=${r.c}/${prod.total}`)))

  // ---- temu_sales_overview（销售总览） ----
  // 今日销量合计须按 SKC 取最新行再求和（同轮采集按页上报、每页独立时间戳，跨页/跨轮直接 sum 会重复计数）
  const [sales] = await rows<{ today_rows: string; today_skc: string; today_vol: string }>(sql`
    with latest as (
      select distinct on (store_id, skc_id) skc_id, today_sales_volume
      from temu_sales_overview where captured_at >= ${today}
      order by store_id, skc_id, captured_at desc, id desc)
    select (select count(*)::text from temu_sales_overview where captured_at >= ${today}) as today_rows,
           (select count(*)::text from latest) as today_skc,
           coalesce((select sum(today_sales_volume) from latest), 0)::text as today_vol`)
  p("sales_overview 今日行数/去重SKC/今日销量合计", `${sales.today_rows} / ${sales.today_skc} / ${sales.today_vol}`)
  const [dash] = await rows<{ sale_volume: string | null }>(sql`
    select (metrics->>'saleVolume') as sale_volume
    from temu_metric_snapshot where source = 'dashboard-stats' and captured_at >= ${today}
    order by captured_at desc limit 1`)
  p("dashboard 今日销量快照", dash?.sale_volume ?? "无")

  // ---- temu_product_flow（流量分析） ----
  const [flow] = await rows<{ goods: string; rows: string }>(sql`
    select count(distinct goods_id)::text as goods, count(*)::text as rows
    from temu_product_flow where source = 'flux-analysis-goods' and captured_at >= ${today}`)
  p("flow 今日 distinct goods / 行数", `${flow.goods} / ${flow.rows}`)

  // ---- temu_product_ads（广告商品报表） ----
  const [ads] = await rows<{ goods: string; roas: string; net_amt: string }>(sql`
    select count(distinct goods_id)::text as goods,
           count(roas_val)::text as roas,
           count(net_order_pay_amt)::text as net_amt
    from temu_product_ads where captured_at >= ${today}`)
  p("ads_product 今日 distinct goods / roasVal非空 / netOrderPayAmt非空", `${ads.goods} / ${ads.roas} / ${ads.net_amt}`)

  // ---- temu_ads_daily（v9 规则验证：今日 gmv/orders 应非空） ----
  const [daily] = await rows<{ d: string; spend: string; gmv: string; orders: string }>(sql`
    select to_char(date, 'MM-DD') as d, coalesce(sum(ad_spend), 0)::text as spend,
           coalesce(sum(gmv), 0)::text as gmv, coalesce(sum(orders), 0)::text as orders
    from temu_ads_daily where date >= current_date - 6 group by 1 order by 1`)
  p("ads_daily 近7日(花费/GMV/订单)", daily ? JSON.stringify(daily) : "无")

  // ---- 各源最新上报时间 ----
  const recent = await rows<{ source: string; n: string; last: string }>(sql`
    select source, count(*)::text as n, to_char(max(ts), 'HH24:MI:SS') as last
    from (
      select 'sales-overview' as source, captured_at as ts from temu_sales_overview where captured_at >= ${today}
      union all select 'products-list', last_seen_at from temu_product where last_seen_at >= ${today} and skc_status is not null
      union all select 'flux-analysis-goods', captured_at from temu_product_flow where captured_at >= ${today}
      union all select 'ads-product-report', captured_at from temu_product_ads where captured_at >= ${today}
    ) t group by 1`)
  p("今日各源行数/最后捕获", JSON.stringify(recent.map((r) => `${r.source}=${r.n}@${r.last}`)))

  // ---- 插件侧 expected 对照（可选） ----
  const expectedRaw = process.env.SWEEP_EXPECTED
  if (expectedRaw) {
    try {
      const expected = JSON.parse(expectedRaw) as Record<string, { captured?: number; expected?: number | null }>
      out.push("--- 与插件 captured/expected 对照 ---")
      for (const [src, e] of Object.entries(expected)) {
        out.push(`${src}: captured=${e.captured ?? "?"} expected=${e.expected ?? "?"}`)
      }
    } catch {
      out.push("SWEEP_EXPECTED 解析失败")
    }
  }

  console.log(out.join("\n"))
  process.exit(0)
}

void main()
