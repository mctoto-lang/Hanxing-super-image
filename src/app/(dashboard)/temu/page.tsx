import Link from "next/link"
import {
  Info,
  Megaphone,
  Package,
  Scale,
  Store as StoreIcon,
  Gauge,
  Truck,
  Upload,
  ClipboardCheck,
} from "lucide-react"
import { requireUserContext } from "@/lib/auth/session"
import { TEMU_TAB_MODULES } from "@/db/schema"
import {
  getTemuOverviewAction,
  getTemuProductsAction,
  getTemuProductsPageAction,
  getTemuAdsAction,
  getTemuCategoryShareAction,
  getTemuSalesTopAction,
  type TemuOverview,
} from "@/server/actions/temu"
import { temuListQuerySchema } from "@/server/schemas/temu"
import { getTemuAdPlansAction } from "@/server/actions/temu-workbench"
import { NoPermission } from "@/components/shared/no-permission"
import { TemuPriceReviewPanel } from "@/components/temu/price-review-panel"
import { TemuPurchasePanel } from "@/components/temu/purchase-panel"
import { TemuQualityPanel } from "@/components/temu/quality-panel"
import { cn } from "@/lib/utils"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { SectionCards } from "@/components/section-cards"
import { ChartAreaInteractive } from "@/components/chart-area-interactive"
import {
  TemuCategoryShare,
  TemuSalesTop10,
  TemuStoreSelect,
  TemuStoreManager,
  TemuAdsWorkbench,
  ProductsInfiniteTable,
  TemuProductsSaleFilter,
} from "@/components/temu"
import { TemuPublishPanel } from "@/components/temu/publish/publish-panel"

export const dynamic = "force-dynamic"

const TABS = [
  { value: "overview", label: "销售概览", icon: Gauge },
  { value: "products", label: "商品信息", icon: Package },
  { value: "publish", label: "商品发布", icon: Upload },
  { value: "ads", label: "广告推广", icon: Megaphone },
  { value: "price", label: "核价调价", icon: Scale },
  { value: "purchase", label: "备货", icon: Truck },
  { value: "qc", label: "质检", icon: ClipboardCheck },
  { value: "stores", label: "店铺", icon: StoreIcon },
] as const

/**
 * Temu 卖家数据面板（URL 驱动 tabs + 店铺筛选）
 *
 * 数据由 TEMU 官方开放平台 API 同步（商品/生命周期/销售/售罄/申报价/广告报表）；
 * 核价调价与活动为官方 API 实时拉取的工作台（写操作限管理员）。
 * 企业隔离 + 店铺二级筛选（?store=）由 Action 内强制。
 *
 * tab 权限：7 个业务 tab 各自对应 temu_* 子模块（超管按企业/权限组配置）；
 * 店铺 tab 不设权限项、仅企业管理员可见。URL 指向不可见 tab 时回落第一个
 * 可见 tab；一个都不可见时整页无权限态。
 */

export default async function TemuPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireUserContext()
  if (!ctx.accessibleModules.includes("temu")) {
    return (
      <NoPermission
        module="店铺管理"
        description="当前企业未开通 TEMU 模块，请联系平台管理员在企业管理中启用。"
      />
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
    range: pick("range") || undefined,
    sort: pick("sort") || undefined,
  })

  const isAdmin = ctx.user.enterpriseRole === "owner" || ctx.user.enterpriseRole === "admin"

  // tab 可见性：业务 tab 按子权限过滤；店铺 tab 仅企业管理员（不设权限项）
  const visibleTabs = TABS.filter((t) =>
    t.value === "stores"
      ? isAdmin
      : ctx.canAccess(TEMU_TAB_MODULES[t.value as keyof typeof TEMU_TAB_MODULES]),
  )
  const activeTab = visibleTabs.some((t) => t.value === query.tab)
    ? query.tab
    : (visibleTabs[0]?.value as typeof query.tab | undefined)
  if (!activeTab) {
    return (
      <NoPermission
        module="店铺管理"
        description="当前企业未开通任何 TEMU 页面权限，请联系平台管理员在企业管理中勾选对应页面。"
      />
    )
  }

  const overview = await getTemuOverviewAction(query.store)

  const tabHref = (tab: string) => {
    const p = new URLSearchParams()
    p.set("tab", tab)
    if (query.store) p.set("store", query.store)
    return `/temu?${p.toString()}`
  }

  // 店铺下拉只列启用店铺；核价调价/广告/备货工作台按店铺 token 调接口，
  // 未选店时默认第一个启用店铺；发品 tab 只列可发布店（全托+token 有效）且必须选具体店
  const enabledStores = overview.stores.filter((s) => s.enabled)
  const publishableStores = overview.stores.filter(
    (s) => s.enabled && s.tokenState === "active" && s.mallType === "full",
  )
  const isPublishTab = activeTab === "publish"
  const workbenchDefaultStore =
    (activeTab === "price" || activeTab === "ads" || activeTab === "purchase" || activeTab === "qc") &&
    !query.store
      ? (enabledStores[0]?.id as string | undefined)
      : isPublishTab && !query.store
        ? (publishableStores[0]?.id as string | undefined)
        : undefined
  const effectiveStore = query.store ?? workbenchDefaultStore

  return (
    // AI 对话页同款布局：绝对定位贴满 header 以下工作区（相对 SidebarInset），
    // 脱离文档流 → 页面级永不出现滚动条；顶栏（折叠按钮+页面标题）钉住，
    // 内容在本容器内部滚动（scrollbar-hide 隐藏滚动条视觉）。p-4 对齐壳层内边距
    <div className="absolute inset-x-0 top-16 bottom-0 flex flex-col space-y-6 overflow-y-auto p-4 scrollbar-hide">
      {/* 页签（Link 驱动，样式对齐 shadcn Tabs）+ 店铺切换下拉 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground">
          {visibleTabs.map((t) => (
            <Link
              key={t.value}
              href={tabHref(t.value)}
              className={cn(
                "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap transition-all",
                activeTab === t.value ? "bg-background text-foreground shadow-sm" : "hover:text-foreground",
              )}
            >
              <t.icon className="size-4" />
              {t.label}
            </Link>
          ))}
        </div>
        {/* 核价/备货/质检/广告/发布五个工作台 tab 按单店 token 调官方接口，
            不提供「全部店铺」；概览/商品信息为本地聚合支持全店 */}
        <TemuStoreSelect
          tab={activeTab}
          current={effectiveStore}
          allowAll={activeTab === "overview" || activeTab === "products"}
          stores={(isPublishTab ? publishableStores : enabledStores).map((s) => ({
            id: s.id,
            name: s.name,
          }))}
        />
      </div>

      {/* tab 内容高度链容器：商品信息页靠它实现表格内部滚动（外层滚动条隐藏） */}
      <div className="flex min-h-0 flex-1 flex-col">
        {activeTab === "overview" && (
          <OverviewTab overview={overview} storeId={query.store} />
        )}
        {activeTab === "products" && <ProductsTab query={query} saleAll={saleRaw === "all"} />}
        {activeTab === "publish" && (
          <TemuPublishPanel
            store={
              publishableStores.find((s) => s.id === effectiveStore) ?? publishableStores[0]
            }
            isAdmin={isAdmin}
          />
        )}
        {activeTab === "ads" && (
          <AdsTab storeId={query.store} range={query.range} workbenchStore={effectiveStore} isAdmin={isAdmin} />
        )}
        {activeTab === "price" && <TemuPriceReviewPanel store={effectiveStore} isAdmin={isAdmin} />}
        {activeTab === "purchase" && <TemuPurchasePanel store={effectiveStore} isAdmin={isAdmin} />}
        {activeTab === "qc" && <TemuQualityPanel store={effectiveStore} />}
        {activeTab === "stores" && <TemuStoreManager stores={overview.stores} />}
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

async function OverviewTab({
  overview,
  storeId,
}: {
  overview: TemuOverview
  storeId?: string
}) {
  // overview 复用页面级已查结果（店铺选择栏也要用），不在此重复执行整组聚合查询
  const [categoryShare, salesTop] = await Promise.all([
    getTemuCategoryShareAction(storeId),
    getTemuSalesTopAction(storeId),
  ])
  const c = overview.cards
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
            label: "今日广告消耗",
            value: fmtMetric(c.adSpend.value, "yuan"),
            delta: c.adSpend.delta,
            footerLead: lead(c.adSpend.delta),
          },
        ]}
      />

      {/* Row2 趋势图：dashboard-01 ChartAreaInteractive 模板原版（desktop=七日销量，mobile=今日销量） */}
      <ChartAreaInteractive
        data={overview.trend.map((t) => ({
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
    </div>
  )
}

// ---------- 商品 ----------

async function ProductsTab({
  query,
  saleAll,
}: {
  query: { store?: string; q?: string; page: number; sale?: 'on' | 'off'; sort?: string }
  /** URL 显式携带 sale=all（全部状态）：query.sale 为 undefined，与「URL 无
   *  sale 参数的缺省在售」两种语义靠该标志区分，切排序/搜索时才不丢筛选 */
  saleAll: boolean
}) {
  // 首屏 20 条 + 对应销量/库存/趋势序列；后续页由 ProductsInfiniteTable 下滑自动加载
  const { rows, salesInfo } = await getTemuProductsPageAction(query.store, query.q, query.sale, 1, query.sort)
  const total = await getTemuProductsAction(query.store, query.q, 1, query.sale, query.sort).then((r) => r.total)
  return (
    // h-full 高度链（根容器固定高 → tab 包装层 flex-1）：CardContent 为内部滚动区
    // （scrollbar-hide 隐藏滚动条），表体滚动/表头吸顶，无限下滑加载
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle className="text-base">商品（{total}）</CardTitle>
        <TemuProductsSaleFilter
          current={query.sale}
          saleAll={saleAll}
          store={query.store}
          q={query.q}
          sort={query.sort ?? "listed"}
        />
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-x-auto overflow-y-auto scrollbar-hide [&_td]:px-4 [&_th]:px-4">
        {/* key 随筛选变：组件内部 useState(initialRows) 不随 props 重置，
            筛选/搜索/排序/切店后必须重建才载入新数据（否则停留旧列表直到手动刷新） */}
        <ProductsInfiniteTable
          key={`${query.store ?? "all"}|${query.q ?? ""}|${query.sale ?? ""}|${query.sort ?? "listed"}`}
          store={query.store}
          q={query.q}
          sale={query.sale}
          sort={query.sort}
          initialRows={rows}
          initialSalesInfo={salesInfo}
        />
      </CardContent>
    </Card>
  )
}

// ---------- 广告推广（ads.temu.com） ----------

async function AdsTab({
  storeId,
  range,
  workbenchStore,
  isAdmin,
}: {
  storeId?: string
  range?: number
  workbenchStore?: string
  isAdmin: boolean
}) {
  const { rows, cards: syncedCards, range: r } = await getTemuAdsAction(storeId, range)
  // 同步窗口无数据时用注册表 detail.query 实时汇总兜底——创建广告后立即出数，
  // 不等 15 分钟同步落库（与前端工作台共用 30s 缓存，不产生额外官方调用）
  const plansRes = workbenchStore ? await getTemuAdPlansAction({ store: workbenchStore }) : null
  const plans = plansRes?.ok ? plansRes.rows : []
  const rtSpend = plans.reduce((s, p) => s + (p.spendFen ?? 0), 0)
  const rtAmt = plans.reduce((s, p) => s + (p.orderPayAmtFen ?? 0), 0)
  const rtOrders = plans.reduce((s, p) => s + (p.orderCnt ?? 0), 0)
  const realtime = syncedCards.totalSpend == null && rtSpend > 0
  const cards = realtime
    ? {
        totalSpend: Math.round(rtSpend) / 100,
        salesAmount: Math.round(rtAmt) / 100,
        roas: rtSpend > 0 ? Math.round((rtAmt / rtSpend) * 100) / 100 : null,
        costPerOrder: rtOrders > 0 ? Math.round(rtSpend / rtOrders) / 100 : null,
      }
    : syncedCards
  const cardItems = [
    {
      label: "总花费",
      value: cards.totalSpend != null ? `¥${cards.totalSpend.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}` : "—",
      hint: realtime ? "官方 API 实时汇总（待同步落库）" : `近 ${r} 日推广花费（官方广告 API）`,
    },
    {
      label: "申报价销售额",
      value: cards.salesAmount != null ? `¥${cards.salesAmount.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}` : "—",
      hint: `近 ${r} 日推广维度申报价口径`,
    },
    {
      label: "投资回报率（ROAS）",
      value: cards.roas != null ? cards.roas.toFixed(2) : "—",
      hint: "申报价销售额 ÷ 总花费",
    },
    {
      label: "每笔成交花费",
      value: cards.costPerOrder != null ? `¥${cards.costPerOrder.toFixed(2)}` : "—",
      hint: "总花费 ÷ 子订单量",
    },
  ]
  return (
    // 平台限制标注条 → 4 大盘卡（渐变样式；同步无数据时实时汇总兜底）→ 商品推广报表
    // （双源合并单表：报表同步行 ∪ 本页创建的注册表行；创建/窗口/刷新工具行）
    <div className="flex h-full min-h-0 flex-col gap-6">
      {/* 平台限制标注条（用户口径：仅本页创建的广告数据可同步） */}
      <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3.5 py-2.5 text-sm text-amber-700 dark:text-amber-400">
        <Info className="mt-0.5 size-4 shrink-0" />
        <p>
          平台限制：仅在<b>本页面通过官方 API 创建</b>的广告，其投放数据可同步展示；
          卖家后台（ads.temu.com）手动创建的广告不在官方接口可见范围（已实测确认）。
        </p>
      </div>
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
      <TemuAdsWorkbench
        store={workbenchStore}
        isAdmin={isAdmin}
        reportRows={rows}
        range={r}
        urlStore={storeId}
      />
    </div>
  )
}
