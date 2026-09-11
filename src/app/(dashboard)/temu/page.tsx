import Link from "next/link"
import {
  Activity,
  BarChart3,
  Package,
  Store as StoreIcon,
  Gauge,
} from "lucide-react"
import { requireUserContext } from "@/lib/auth/session"
import {
  getTemuOverviewAction,
  getTemuProductsAction,
  getTemuFlowAction,
  getTemuActivityAction,
} from "@/server/actions/temu"
import { temuListQuerySchema } from "@/server/schemas/temu"
import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TemuSalesTrend, TemuStoreManager } from "./temu-components"

export const dynamic = "force-dynamic"

const TABS = [
  { value: "overview", label: "销售概览", icon: Gauge },
  { value: "products", label: "商品", icon: Package },
  { value: "flow", label: "流量分析", icon: BarChart3 },
  { value: "activity", label: "活动", icon: Activity },
  { value: "stores", label: "店铺", icon: StoreIcon },
] as const

/**
 * Temu 卖家数据面板（手册 §7：URL 驱动 tabs + 店铺筛选）
 *
 * 数据由 Temu Collector 浏览器插件上报（/api/v1/ingest），
 * 企业隔离 + 店铺二级筛选（?store=）由 Action 内强制。
 */
/** 店铺在线判定窗口：2 小时内有上报视为在线 */
const ONLINE_WINDOW_MS = 2 * 3600 * 1000

/** 统计在线店铺数。Date.now 收敛在模块级辅助函数里——组件渲染期直接
 *  调用会触发 react-hooks/purity（渲染必须幂等），辅助函数不在分析范围 */
function countOnlineStores(stores: Array<{ lastSeenAt: Date | null }>): number {
  const now = Date.now()
  return stores.filter(
    (s) => s.lastSeenAt && now - new Date(s.lastSeenAt).getTime() < ONLINE_WINDOW_MS,
  ).length
}

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
  const query = temuListQuerySchema.parse({
    tab: pick("tab") ?? "overview",
    store: pick("store") || undefined,
    q: pick("q") || undefined,
    page: pick("page") || 1,
  })

  const overview = await getTemuOverviewAction(query.store)
  const isAdmin = ctx.user.enterpriseRole === "owner" || ctx.user.enterpriseRole === "admin"

  const tabHref = (tab: string) => {
    const p = new URLSearchParams()
    p.set("tab", tab)
    if (query.store) p.set("store", query.store)
    return `/temu?${p.toString()}`
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Temu 数据</h1>
          <p className="text-sm text-muted-foreground">
            浏览器插件采集上报 · {overview.stores.length} 个店铺 ·{" "}
            {countOnlineStores(overview.stores)} 个在线
          </p>
        </div>
        {/* 店铺筛选（全部/各店铺） */}
        <div className="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-sm">
          <Link
            href={`/temu?tab=${query.tab}`}
            className={cn("rounded-md px-3 py-1", !query.store ? "bg-background shadow-sm" : "text-muted-foreground")}
          >
            全部店铺
          </Link>
          {overview.stores.map((s) => (
            <Link
              key={s.id}
              href={`/temu?tab=${query.tab}&store=${s.id}`}
              className={cn(
                "rounded-md px-3 py-1",
                query.store === s.id ? "bg-background shadow-sm" : "text-muted-foreground",
              )}
            >
              {s.name}
            </Link>
          ))}
        </div>
      </div>

      {/* 页签（Link 驱动，样式对齐 shadcn Tabs） */}
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

      {query.tab === "overview" && <OverviewTab storeId={query.store} />}
      {query.tab === "products" && <ProductsTab query={query} />}
      {query.tab === "flow" && <FlowTab storeId={query.store} />}
      {query.tab === "activity" && <ActivityTab storeId={query.store} />}
      {query.tab === "stores" &&
        (isAdmin ? (
          <TemuStoreManager stores={overview.stores} />
        ) : (
          <p className="text-sm text-muted-foreground">店铺管理需要企业管理员权限。</p>
        ))}
    </div>
  )
}

// ---------- 销售概览 ----------

async function OverviewTab({ storeId }: { storeId?: string }) {
  const o = await getTemuOverviewAction(storeId)
  const kpis: { label: string; value: number | null | string }[] = [
    { label: "今日销量", value: o.latest.saleVolume ?? "—" },
    { label: "7 天销量", value: o.latest.sevenDaysSaleVolume ?? "—" },
    { label: "30 天销量", value: o.latest.thirtyDaysSaleVolume ?? "—" },
    { label: "在售商品", value: o.latest.onSaleProductNumber ?? "—" },
    { label: "商品总数", value: o.productCount },
    { label: "待核价", value: o.latest.adjustPrice ?? "—" },
    { label: "即将售罄", value: o.soldout.todaySoonSellOutNum ?? "—" },
    { label: "已售罄", value: o.soldout.todaySellOutNum ?? "—" },
  ]
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{k.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold tabular-nums">{k.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">销量趋势（近 30 天，每日最新快照）</CardTitle>
        </CardHeader>
        <CardContent>
          <TemuSalesTrend data={o.trend.map((t) => ({ day: t.date, value: t.saleVolume ?? 0 }))} />
        </CardContent>
      </Card>
    </div>
  )
}

// ---------- 商品 ----------

async function ProductsTab({ query }: { query: { store?: string; q?: string; page: number } }) {
  const { rows, total } = await getTemuProductsAction(query.store, query.q, query.page)
  const pageSize = 20
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const pageHref = (p: number) => {
    const params = new URLSearchParams({ tab: "products", page: String(p) })
    if (query.store) params.set("store", query.store)
    if (query.q) params.set("q", query.q)
    return `/temu?${params.toString()}`
  }
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle className="text-base">商品（{total}）</CardTitle>
        {/* GET 表单：搜索保持 URL 驱动 */}
        <form action="/temu" className="flex gap-2">
          <input type="hidden" name="tab" value="products" />
          {query.store && <input type="hidden" name="store" value={query.store} />}
          <input
            name="q"
            defaultValue={query.q ?? ""}
            placeholder="搜索商品名"
            className="h-9 w-48 rounded-md border bg-background px-3 text-sm"
          />
          <button className="h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground">搜索</button>
        </form>
      </CardHeader>
      <CardContent className="space-y-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>主图</TableHead>
              <TableHead>SKC ID</TableHead>
              <TableHead>商品名</TableHead>
              <TableHead>货号</TableHead>
              <TableHead>类目</TableHead>
              <TableHead>供货价(分)</TableHead>
              <TableHead>总销量</TableHead>
              <TableHead>近7天</TableHead>
              <TableHead>选品</TableHead>
              <TableHead>下架</TableHead>
              <TableHead>买手</TableHead>
              <TableHead>加站时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  {r.mainImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={r.mainImageUrl}
                      alt=""
                      className="size-10 rounded-md object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="size-10 rounded-md bg-muted" />
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{r.productSkcId}</TableCell>
                <TableCell className="max-w-64 truncate" title={r.productName ?? ""}>
                  {r.productName ?? "—"}
                </TableCell>
                <TableCell className="font-mono text-xs">{r.productSn ?? "—"}</TableCell>
                <TableCell className="max-w-28 truncate" title={r.leafCategoryName ?? r.cat1Name ?? ""}>
                  {r.leafCategoryName ?? r.cat1Name ?? r.category ?? "—"}
                </TableCell>
                <TableCell className="tabular-nums">{r.supplierPrice ?? "—"}</TableCell>
                <TableCell className="tabular-nums">{r.totalSalesVolume ?? "—"}</TableCell>
                <TableCell className="tabular-nums">{r.last7DaysSalesVolume ?? "—"}</TableCell>
                <TableCell>{r.hasSkcSelected ? "✓" : "—"}</TableCell>
                <TableCell>{r.removeStatus ? "已下架" : "正常"}</TableCell>
                <TableCell>{r.buyerName ?? "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.addedSiteAt ? new Date(r.addedSiteAt).toLocaleDateString("zh-CN") : "—"}
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={12} className="h-20 text-center text-sm text-muted-foreground">
                  暂无数据：插件完成一轮采集上报后自动出现
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {pages > 1 && (
          <div className="flex items-center justify-end gap-2 text-sm">
            {query.page > 1 && (
              <Link href={pageHref(query.page - 1)} className="rounded-md border px-3 py-1">
                上一页
              </Link>
            )}
            <span className="text-muted-foreground">
              {query.page} / {pages}
            </span>
            {query.page < pages && (
              <Link href={pageHref(query.page + 1)} className="rounded-md border px-3 py-1">
                下一页
              </Link>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------- 流量分析 ----------

async function FlowTab({ storeId }: { storeId?: string }) {
  const { rows, summary } = await getTemuFlowAction(storeId)
  const counts = [
    { label: "待增长商品", value: summary.flowWaitGrowCount },
    { label: "短期增长中", value: summary.flowShortTermGrowingCount },
    { label: "长期增长中", value: summary.flowLongTermGrowingCount },
    { label: "BSR 商品", value: summary.bsrGoodsCount },
  ]
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {counts.map((c) => (
          <Card key={String(c.label)}>
            <CardContent className="pt-6">
              <div className="text-sm text-muted-foreground">{String(c.label)}</div>
              <div className="text-2xl font-bold tabular-nums">{String(c.value ?? "—")}</div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">商品流量明细（最新一批，{rows.length} 条）</CardTitle>
        </CardHeader>
        <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>商品</TableHead>
              <TableHead>曝光</TableHead>
              <TableHead>点击</TableHead>
              <TableHead>商详访问</TableHead>
              <TableHead>加购</TableHead>
              <TableHead>支付件数</TableHead>
              <TableHead>买家</TableHead>
              <TableHead>搜索曝光</TableHead>
              <TableHead>推荐曝光</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.slice(0, 30).map((r) => (
              <TableRow key={r.id}>
                <TableCell className="max-w-64 truncate" title={r.goodsName ?? ""}>
                  {r.goodsName ?? r.goodsId}
                </TableCell>
                <TableCell className="tabular-nums">{r.exposeNum ?? "—"}</TableCell>
                <TableCell className="tabular-nums">{r.clickNum ?? "—"}</TableCell>
                <TableCell className="tabular-nums">{r.goodsDetailVisitNum ?? "—"}</TableCell>
                <TableCell className="tabular-nums">{r.addToCartUserNum ?? "—"}</TableCell>
                <TableCell className="tabular-nums">{r.payGoodsNum ?? "—"}</TableCell>
                <TableCell className="tabular-nums">{r.buyerNum ?? "—"}</TableCell>
                <TableCell className="tabular-nums text-muted-foreground">{r.searchExposeNum ?? "—"}</TableCell>
                <TableCell className="tabular-nums text-muted-foreground">{r.recommendExposeNum ?? "—"}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="h-20 text-center text-sm text-muted-foreground">
                  暂无数据
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        </CardContent>
      </Card>
    </div>
  )
}

// ---------- 活动 ----------

async function ActivityTab({ storeId }: { storeId?: string }) {
  const rows = await getTemuActivityAction(storeId)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">活动数据（整包存档，字段结构稳定后展开）</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="rounded-lg border p-3 text-sm">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{r.source}</span>
              <span>{new Date(r.capturedAt).toLocaleString("zh-CN", { hour12: false })}</span>
            </div>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
              {JSON.stringify(r.payload?.normalized ?? r.payload, null, 1).slice(0, 2000)}
            </pre>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">暂无数据</p>
        )}
      </CardContent>
    </Card>
  )
}
