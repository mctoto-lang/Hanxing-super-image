import Link from "next/link"
import {
  BarChart3,
  Megaphone,
  Package,
  Store as StoreIcon,
  Gauge,
} from "lucide-react"
import { requireUserContext } from "@/lib/auth/session"
import {
  getTemuOverviewAction,
  getTemuProductsAction,
  getTemuProductsPageAction,
  getTemuFlowAction,
  getTemuAdsAction,
  getTemuCategoryShareAction,
  getTemuSalesTopAction,
  getTemuAdsEffectAction,
  getTemuFlowFunnelAction,
  getDiscoveredMallsAction,
  type TemuFlowFunnel,
} from "@/server/actions/temu"
import { temuListQuerySchema } from "@/server/schemas/temu"
import { cn } from "@/lib/utils"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { SectionCards } from "@/components/section-cards"
import { ChartAreaInteractive } from "@/components/chart-area-interactive"
import {
  TemuCategoryShare,
  TemuSalesTop10,
  TemuStoreSelect,
  TemuAdsEffectCard,
  TemuStoreManager,
  ProductsInfiniteTable,
  TemuProductsSaleFilter,
  ProductNameCell,
  FlowExposeCell,
} from "./temu-components"

export const dynamic = "force-dynamic"

const TABS = [
  { value: "overview", label: "销售概览", icon: Gauge },
  { value: "products", label: "商品信息", icon: Package },
  { value: "flow", label: "流量分析", icon: BarChart3 },
  { value: "ads", label: "广告推广", icon: Megaphone },
  { value: "stores", label: "店铺", icon: StoreIcon },
] as const

/**
 * Temu 卖家数据面板（手册 §7：URL 驱动 tabs + 店铺筛选）
 *
 * 数据由 Temu Collector 浏览器插件上报（/api/v1/ingest），
 * 企业隔离 + 店铺二级筛选（?store=）由 Action 内强制。
 */

export default async function TemuPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireUserContext()
  if (!ctx.accessibleModules.includes("temu")) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        当前企业未开通 Temu 数据模块，请联系平台管理员在企业管理中启用。
      </div>
    )
  }

  const sp = await searchParams
  const pick = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]) as string | undefined
  // 在售筛选缺省"在售"；sale=all 为显式"全部"（哨兵值，避免选了全部又被缺省值覆盖）
  const saleRaw = pick("sale")
  const sale = saleRaw === "all" ? undefined : saleRaw === "off" ? "off" : "on"
  const query = temuListQuerySchema.parse({
    tab: pick("tab") ?? "overview",
    store: pick("store") || undefined,
    q: pick("q") || undefined,
    sale,
    page: pick("page") || 1,
  })

  const overview = await getTemuOverviewAction(query.store)
  const isAdmin = ctx.user.enterpriseRole === "owner" || ctx.user.enterpriseRole === "admin"
  const discovered = query.tab === "stores" && isAdmin ? await getDiscoveredMallsAction() : []

  const tabHref = (tab: string) => {
    const p = new URLSearchParams()
    p.set("tab", tab)
    if (query.store) p.set("store", query.store)
    return `/temu?${p.toString()}`
  }

  return (
    // AI 对话页同款布局：绝对定位贴满 header 以下工作区（相对 SidebarInset），
    // 脱离文档流 → 页面级永不出现滚动条；顶栏（折叠按钮+页面标题）钉住，
    // 内容在本容器内部滚动（scrollbar-hide 隐藏滚动条视觉）。p-4 对齐壳层内边距
    <div className="absolute inset-x-0 top-16 bottom-0 flex flex-col space-y-6 overflow-y-auto p-4 scrollbar-hide">
      {/* 页签（Link 驱动，样式对齐 shadcn Tabs）+ 店铺切换下拉 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground">
          {TABS.map((t) => (
            <Link
              key={t.value}
              href={tabHref(t.value)}
              className={cn(
                "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap transition-all",
                query.tab === t.value ? "bg-background text-foreground shadow-sm" : "hover:text-foreground",
              )}
            >
              <t.icon className="size-4" />
              {t.label}
            </Link>
          ))}
        </div>
        <TemuStoreSelect
          tab={query.tab}
          current={query.store}
          stores={overview.stores.map((s) => ({ id: s.id, name: s.name }))}
        />
      </div>

      {/* tab 内容高度链容器：商品信息页靠它实现表格内部滚动（外层滚动条隐藏） */}
      <div className="flex min-h-0 flex-1 flex-col">
        {query.tab === "overview" && <OverviewTab storeId={query.store} />}
        {query.tab === "products" && <ProductsTab query={query} />}
        {query.tab === "flow" && <FlowTab storeId={query.store} />}
        {query.tab === "ads" && <AdsTab storeId={query.store} />}
        {query.tab === "stores" &&
          (isAdmin ? (
            <TemuStoreManager stores={overview.stores} discovered={discovered} />
          ) : (
            <p className="text-sm text-muted-foreground">店铺管理需要企业管理员权限。</p>
          ))}
      </div>
    </div>
  )
}

// ---------- 销售概览 ----------

/** 数值格式化：金额（元，千分位）与数量 */
function fmtMetric(value: number | null, unit: "count" | "yuan") {
  if (value == null) return "—"
  if (unit === "yuan") return `¥${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`
  return value.toLocaleString("zh-CN")
}

async function OverviewTab({ storeId }: { storeId?: string }) {
  const [o, categoryShare, salesTop, adsEffect, funnel] = await Promise.all([
    getTemuOverviewAction(storeId),
    getTemuCategoryShareAction(storeId),
    getTemuSalesTopAction(storeId),
    getTemuAdsEffectAction(storeId),
    getTemuFlowFunnelAction(storeId),
  ])
  const c = o.cards
  const lead = (delta: number | null) =>
    delta == null
      ? null
      : `${delta >= 0 ? "较昨日增长" : "较昨日下降"} ${Math.abs(delta)}%`
  return (
    <div className="@container/main space-y-6">
      {/* Row1 顶部四卡片：dashboard-01 SectionCards 模板原版（今日/七日/30日销量 + 今日广告消耗） */}
      <SectionCards
        cards={[
          {
            label: "今日销量",
            value: fmtMetric(c.todaySales.value, "count"),
            delta: c.todaySales.delta,
            footerLead: lead(c.todaySales.delta),
          },
          {
            label: "七日销量",
            value: fmtMetric(c.sevenDaySales.value, "count"),
            delta: c.sevenDaySales.delta,
            footerLead: lead(c.sevenDaySales.delta),
          },
          {
            label: "30日销量",
            value: fmtMetric(c.thirtyDaySales.value, "count"),
            delta: c.thirtyDaySales.delta,
            footerLead: lead(c.thirtyDaySales.delta),
          },
          {
            label: "广告消耗",
            value: fmtMetric(c.adSpend.value, "yuan"),
            delta: c.adSpend.delta,
            footerLead: lead(c.adSpend.delta),
          },
        ]}
      />

      {/* Row2 趋势图：dashboard-01 ChartAreaInteractive 模板原版（desktop=七日销量，mobile=今日销量） */}
      <ChartAreaInteractive
        data={o.trend.map((t) => ({
          date: t.date,
          desktop: t.sevenDays,
          mobile: t.saleVolume,
        }))}
      />

      {/* Row3 左：售出类目占比（环形图）｜右：售出 TOP10（横向条形图，分色） */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <TemuCategoryShare data={categoryShare} />
        <TemuSalesTop10 data={salesTop} />
      </div>

      {/* Row4 附加统计：广告效果｜转化漏斗 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TemuAdsEffectCard effect={adsEffect} />
        <FunnelCard funnel={funnel} />
      </div>
    </div>
  )
}

// ---------- 转化漏斗（服务端组件，纯 div 条形） ----------

const FUNNEL_STAGES = [
  { key: "exposeNum", label: "曝光", color: "var(--chart-1)" },
  { key: "clickNum", label: "点击", color: "var(--chart-2)" },
  { key: "goodsDetailVisitNum", label: "商详访问", color: "var(--chart-3)" },
  { key: "addToCartUserNum", label: "加购", color: "var(--chart-4)" },
  { key: "payGoodsNum", label: "支付件数", color: "var(--chart-5)" },
] as const

function FunnelCard({ funnel }: { funnel: TemuFlowFunnel | null }) {
  const hasData = funnel != null && funnel.exposeNum > 0
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>转化漏斗</CardTitle>
        <CardDescription>流量分析最新批次 · 曝光 → 点击 → 商详 → 加购 → 支付</CardDescription>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            暂无流量数据（插件上报后自动出现）
          </div>
        ) : (
          <div className="space-y-3">
            {FUNNEL_STAGES.map((stage, i) => {
              const value = funnel[stage.key]
              const pctOfTop = Math.max(1, Math.round((value / funnel.exposeNum) * 100))
              const prev = i > 0 ? funnel[FUNNEL_STAGES[i - 1].key] : null
              const stepRate = prev != null && prev > 0 ? Math.round((value / prev) * 1000) / 10 : null
              return (
                <div key={stage.key} className="space-y-1">
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-muted-foreground">{stage.label}</span>
                    <span className="font-medium tabular-nums">
                      {value.toLocaleString("zh-CN")}
                      {stepRate != null && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          环节转化 {stepRate}%
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="h-5 w-full overflow-hidden rounded-sm bg-muted/50">
                    <div
                      className="h-full rounded-sm"
                      style={{ width: `${pctOfTop}%`, backgroundColor: stage.color, opacity: 0.85 }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------- 商品 ----------

async function ProductsTab({
  query,
}: {
  query: { store?: string; q?: string; page: number; sale?: 'on' | 'off' }
}) {
  // 首屏 20 条 + 对应销量/库存/趋势序列；后续页由 ProductsInfiniteTable 下滑自动加载
  const { rows, salesInfo } = await getTemuProductsPageAction(query.store, query.q, query.sale, 1)
  const total = await getTemuProductsAction(query.store, query.q, 1, query.sale).then((r) => r.total)
  return (
    // h-full 高度链（根容器固定高 → tab 包装层 flex-1）：CardContent 为内部滚动区
    // （scrollbar-hide 隐藏滚动条），表体滚动/表头吸顶，无限下滑加载
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle className="text-base">商品（{total}）</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <TemuProductsSaleFilter current={query.sale} store={query.store} q={query.q} />
          {/* GET 表单：搜索保持 URL 驱动 */}
          <form action="/temu" className="flex gap-2">
            <input type="hidden" name="tab" value="products" />
            {query.store && <input type="hidden" name="store" value={query.store} />}
            {/* 保持当前在售筛选：全部用 all 哨兵，避免搜索后回落到缺省"在售" */}
            <input type="hidden" name="sale" value={query.sale ?? "all"} />
            <input
              name="q"
              defaultValue={query.q ?? ''}
              placeholder="搜索 SKC/SPU/货号/商品名"
              className="h-9 w-56 rounded-md border bg-background px-3 text-sm"
            />
            <button className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground">搜索</button>
          </form>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-y-auto scrollbar-hide [&_td]:px-4 [&_th]:px-4">
        <ProductsInfiniteTable
          store={query.store}
          q={query.q}
          sale={query.sale}
          initialRows={rows}
          initialSalesInfo={salesInfo}
        />
      </CardContent>
    </Card>
  )
}

// ---------- 流量分析 ----------

/** 比率格式化：null → —，否则 xx.xx% */
function fmtRate(v: number | null) {
  return v == null ? "—" : `${v}%`
}

async function FlowTab({ storeId }: { storeId?: string }) {
  const { rows, cards } = await getTemuFlowAction(storeId)
  const cardItems = [
    { label: "今日总访客数", value: cards.todayVisitors?.toLocaleString("zh-CN") ?? "—", hint: "商详 & 店铺首页去重人数，每日仅计一次" },
    { label: "今日支付买家数", value: cards.todayBuyers?.toLocaleString("zh-CN") ?? "—", hint: "今日支付的买家去重数" },
    { label: "今日转化率", value: cards.todayConversionRate != null ? `${cards.todayConversionRate}%` : "—", hint: "今日支付买家数 ÷ 总访客数" },
  ]
  const conv = (r: typeof rows[number]) =>
    r.goodsDetailVisitorNum && r.goodsDetailVisitorNum > 0 && r.buyerNum != null
      ? Math.round((r.buyerNum / r.goodsDetailVisitorNum) * 10000) / 100
      : null
  const ctr = (r: typeof rows[number]) =>
    r.exposeNum && r.exposeNum > 0 && r.clickNum != null
      ? Math.round((r.clickNum / r.exposeNum) * 10000) / 100
      : null
  return (
    // 商品信息页同款高度链：三卡固定（概览页卡片同款渐变样式），表格卡内部滚动
    <div className="flex h-full min-h-0 flex-col gap-6">
      <div
        className="grid grid-cols-1 gap-4 *:data-[slot=card]:bg-linear-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs sm:grid-cols-3 dark:*:data-[slot=card]:bg-card"
      >
        {cardItems.map((c) => (
          // 与概览 SectionCards 同构（Header 描述+大数字 + Footer 两行），
          // 三页顶部卡片行高一致
          <Card key={c.label} className="@container/card">
            <CardHeader>
              <CardDescription>{c.label}</CardDescription>
              <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
                {c.value}
              </CardTitle>
            </CardHeader>
            <CardFooter className="flex-col items-start gap-1.5 text-sm">
              <div className="line-clamp-1 flex gap-2 font-medium">{c.hint}</div>
            </CardFooter>
          </Card>
        ))}
      </div>
      <Card className="flex min-h-0 flex-1 flex-col">
        <CardHeader>
          <CardTitle className="text-base">商品流量明细（最新一批 {rows.length} 条 · 采集口径今日）</CardTitle>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-y-auto scrollbar-hide [&_td]:px-4 [&_th]:px-4">
          {/* 原生 table：Table 组件的 overflow-x-auto 包装层会让 sticky 表头贴不到本滚动区 */}
          <table className="w-full caption-bottom text-sm">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead>主图</TableHead>
                <TableHead>SPU</TableHead>
                <TableHead>商品名</TableHead>
                <TableHead>货号</TableHead>
                <TableHead className="text-right">申报价格</TableHead>
                <TableHead className="text-right">曝光量</TableHead>
                <TableHead className="text-right">点击量</TableHead>
                <TableHead className="text-right">访客数</TableHead>
                <TableHead className="text-right">浏览量</TableHead>
                <TableHead className="text-right">点击率</TableHead>
                <TableHead className="text-right">转化率</TableHead>
                <TableHead className="text-right">支付件数</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    {r.goodsImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.goodsImageUrl} alt="" className="size-10 rounded-md object-cover" loading="lazy" />
                    ) : (
                      <div className="size-10 rounded-md bg-muted" />
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.goodsId}</TableCell>
                  <TableCell>
                    <ProductNameCell name={r.goodsName} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.productSn ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.supplierPrice != null ? `¥${(r.supplierPrice / 100).toFixed(2)}` : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <FlowExposeCell
                      expose={r.exposeNum}
                      searchExpose={r.searchExposeNum}
                      recommendExpose={r.recommendExposeNum}
                    />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.clickNum ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.goodsDetailVisitorNum ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.goodsDetailVisitNum ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtRate(ctr(r))}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtRate(conv(r))}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.payGoodsNum ?? "—"}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={12} className="h-20 text-center text-sm text-muted-foreground">
                    暂无数据（插件上报后自动出现）
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </table>
        </CardContent>
      </Card>
    </div>
  )
}

// ---------- 商品推广（ads.temu.com） ----------

async function AdsTab({ storeId }: { storeId?: string }) {
  const { rows, cards } = await getTemuAdsAction(storeId)
  const yuan = (v: number | null | undefined) =>
    v == null ? "—" : `¥${(v / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`
  // ROAS 统一 XX.XX 两位小数：原始字符串可解析且量级正常则格式化，
  // 否则按行内花费与销售额推导，避免极端怪值直出
  const roas = (r: typeof rows[number]) => {
    const v = Number(r.roasVal)
    if (Number.isFinite(v) && v > 0 && v < 1000) return v.toFixed(2)
    const g = r.gmv ?? r.netOrderPayAmt
    if (g != null && r.spend != null && r.spend > 0) return (g / r.spend).toFixed(2)
    return "—"
  }
  const cardItems = [
    {
      label: "总花费",
      value: cards.totalSpend != null ? `¥${cards.totalSpend.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}` : "—",
      hint: "今日全部推广商品花费之和",
    },
    {
      label: "申报价销售额（全域）",
      value: cards.salesAmount != null ? `¥${cards.salesAmount.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}` : "—",
      hint: "全域申报价口径 GMV",
    },
    {
      label: "投资回报率（ROAS）（全域）",
      value: cards.roas != null ? cards.roas.toFixed(2) : "—",
      hint: "申报价销售额 ÷ 总花费",
    },
    {
      label: "每笔订单成交花费（全域）",
      value: cards.costPerOrder != null ? `¥${cards.costPerOrder}` : "—",
      hint: "总花费 ÷ 成交订单数",
    },
  ]
  return (
    // 流量分析页同款：4 大盘卡（渐变样式）+ 表格卡内部滚动（sticky 表头）
    <div className="flex h-full min-h-0 flex-col gap-6">
      <div
        className="grid grid-cols-1 gap-4 *:data-[slot=card]:bg-linear-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs sm:grid-cols-2 xl:grid-cols-4 dark:*:data-[slot=card]:bg-card"
      >
        {cardItems.map((c) => (
          // 与概览 SectionCards 同构（Header 描述+大数字 + Footer 两行），
          // 三页顶部卡片行高一致
          <Card key={c.label} className="@container/card">
            <CardHeader>
              <CardDescription>{c.label}</CardDescription>
              <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
                {c.value}
              </CardTitle>
            </CardHeader>
            <CardFooter className="flex-col items-start gap-1.5 text-sm">
              <div className="line-clamp-1 flex gap-2 font-medium">{c.hint}</div>
            </CardFooter>
          </Card>
        ))}
      </div>
      <Card className="flex min-h-0 flex-1 flex-col">
        <CardHeader>
          <CardTitle className="text-base">商品推广报表（今日批次 {rows.length} 条 · 当日未采集时为空）</CardTitle>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-y-auto scrollbar-hide [&_td]:px-4 [&_th]:px-4">
          {/* 原生 table：避免 Table 组件 overflow 包装层拦截 sticky 表头 */}
          <table className="w-full caption-bottom text-sm">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead>主图</TableHead>
                <TableHead>SPU</TableHead>
                <TableHead className="text-right">花费</TableHead>
                <TableHead className="text-right">净申报价销售额（全域）</TableHead>
                <TableHead className="text-right">投资回报率（ROAS）（全域）</TableHead>
                <TableHead className="text-right">净每笔成交花费</TableHead>
                <TableHead className="text-right">净件数</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    {r.mainImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.mainImageUrl} alt="" className="size-10 rounded-md object-cover" loading="lazy" />
                    ) : (
                      <div className="size-10 rounded-md bg-muted" />
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.goodsId ?? r.skcId}</TableCell>
                  <TableCell className="text-right tabular-nums">{yuan(r.spend)}</TableCell>
                  <TableCell className="text-right tabular-nums">{yuan(r.netOrderPayAmt)}</TableCell>
                  <TableCell className="text-right tabular-nums">{roas(r)}</TableCell>
                  <TableCell className="text-right tabular-nums">{yuan(r.netTransactionCost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.netGoodsNum ?? "—"}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="h-20 text-center text-sm text-muted-foreground">
                    暂无数据：插件在 ads.temu.com 推广报表页采集后自动出现
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </table>
        </CardContent>
      </Card>
    </div>
  )
}
