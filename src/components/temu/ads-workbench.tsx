"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Megaphone, MoreHorizontal, Pause, Play, RefreshCw } from "lucide-react"
import { DashRing } from "@/components/ui/dash-ring"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TEMU_TABLE_HEADER_CLASS } from "@/components/temu/table-header-style"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ZoomableImage } from "@/components/ui/zoomable-image"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import type { TemuAdsRow } from "@/server/actions/temu"
import { temuImageSrc } from "@/lib/temu/image"
import { cn } from "@/lib/utils"
import { EmptyHint } from "@/components/temu/products-table"
import { TemuSearchBar, type SearchBarField } from "@/components/temu/search-bar"
import { TruncTip } from "@/components/temu/trunc-tip"
import { TableSkeletonRows } from "@/components/temu/table-skeleton"
import { TEMU_AD_STATUS_TONE, type TemuAdStatusTone } from "@/lib/temu-api/workbench-labels"
import {
  getTemuAdPlansAction,
  listTemuAdProductsAction,
  createTemuAdsAction,
  modifyTemuAdAction,
  predictTemuAdRoasAction,
  type TemuAdPlanRow,
  type TemuAdProductRow,
} from "@/server/actions/temu-workbench"

/**
 * 广告推广工作台（官方 bg.glo.searchrec.ad.* + temu_ad 注册表）。
 *
 * 「商品推广报表」= 双源合并单表：报表同步行（temu_ads_product_daily 窗口聚合，
 * 近 N 日口径）∪ 本页创建的注册表行（detail.query 实时状态/预算/目标ROAS）。
 * 同名列报表窗口值优先、实时值兜底（刚创建未同步的行）；状态/操作列仅注册表行有。
 *
 * 平台限制（2026-10-20 实测）：卖家后台手动创建的广告对官方接口不可见，
 * 仅通过本页（API）创建的广告数据可同步展示。写操作需广告推广页 tab 权限（action 内强制）。
 */

/** 金额展示（分→元）；-1=官方「不限预算」口径，null=无值 */
const yuan = (fen: number | null | undefined) =>
  fen == null ? "—" : fen === -1 ? "不限" : `¥${(fen / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`

const num = (v: number | null | undefined) =>
  v == null ? "—" : v.toLocaleString("zh-CN")

/** 共享搜索条可搜索项（双源合并行客户端过滤——官方报表/计划接口均无关键词入参） */
const ADS_SEARCH_FIELDS: SearchBarField[] = [
  { value: "all", label: "全部", placeholder: "货号 / 商品名 / 商品ID" },
  { value: "sn", label: "货号", placeholder: "输入货号" },
  { value: "name", label: "商品名", placeholder: "输入商品名关键词" },
]

/** 我的广告行 + 店铺归属（全部店铺视图扇出合并时逐店标注；操作按行自带店铺提交） */
type PlanWithStore = TemuAdPlanRow & { storeId: string; storeName: string }

/** 报表行与注册表行按 (店铺, productId) 对齐后的合并行（跨店同商品不串行） */
interface MergedAdRow {
  /** 合并键 = storeId:productId */
  rowKey: string
  storeId: string | null
  storeName: string | null
  productId: string
  mainImageUrl: string | null
  /** 主图转存 URL（报表行 temu_product 反查带出；展示优先） */
  mainImageCosUrl: string | null
  productName: string | null
  productSn: string | null
  plan: PlanWithStore | null
  report: TemuAdsRow | null
}

/** 目标 ROAS 展示：归一后的数值保留最多两位小数（12 / 13.5 / 1.71） */
const fmtRoas = (v: number | null | undefined) =>
  v == null ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(2)

/** 状态徽标五色语义（对齐商品信息页 skcStatusView 浅底深字形态 + dark 变体） */
const AD_STATUS_TONE_CLS: Record<TemuAdStatusTone, string> = {
  green: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  gray: "bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300",
  blue: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  red: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
}

export function TemuAdsWorkbench({
  store,
  stores,
  reportRows,
  range,
  urlStore,
}: {
  /** 工作台操作店铺；undefined=全部店铺视图（逐店扇出实时拉取，行级操作可用） */
  store?: string
  /** 启用店铺清单（全部店铺视图扇出 / 创建广告弹窗选店） */
  stores: { id: string; name: string }[]
  /** 报表同步聚合行（服务端 getTemuAdsAction，近 N 日窗口口径） */
  reportRows: TemuAdsRow[]
  range: number
  /** URL 上的 store 参数（窗口下拉跳转保持一致；undefined=全部店铺） */
  urlStore?: string
}) {
  const router = useRouter()
  const [plans, setPlans] = React.useState<PlanWithStore[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [loading, startLoading] = React.useTransition()
  const [creating, setCreating] = React.useState(false)
  const [modifying, setModifying] = React.useState<
    { row: PlanWithStore; action: "pause" | "open" | "budget" | "roas" } | null
  >(null)
  /** 修改请求进行中（下传确认弹窗禁用确认按钮，防连点重复提交官方写操作） */
  const [modifyPending, setModifyPending] = React.useState(false)
  /** 共享搜索条（按钮/回车触发提交；空关键词=清除筛选）——draft 两态防逐键过滤 */
  const [searchField, setSearchField] = React.useState(ADS_SEARCH_FIELDS[0]!.value)
  const [searchKeyword, setSearchKeyword] = React.useState("")
  const [appliedSearch, setAppliedSearch] = React.useState<{ field: string; keyword: string }>({
    field: ADS_SEARCH_FIELDS[0]!.value,
    keyword: "",
  })

  const load = React.useCallback(() => {
    startLoading(async () => {
      if (store) {
        const name = stores.find((s) => s.id === store)?.name ?? ""
        const r = await getTemuAdPlansAction({ store })
        if (r.ok) {
          setPlans(r.rows.map((p) => ({ ...p, storeId: store, storeName: name })))
          setError(null)
        } else {
          setPlans([])
          setError(r.error)
        }
        return
      }
      // 全部店铺视图：逐店扇出实时拉取「我的广告」（并发度 2——detail.query
      // 分批自带 1.5s 停顿，全并发会叠官方 QPS）；失败店汇总提示不阻断其他店
      const queue = [...stores]
      const out: PlanWithStore[] = []
      const errs: string[] = []
      const worker = async () => {
        for (;;) {
          const s = queue.shift()
          if (!s) return
          // 网络层 throw（权限校验等，非 ok:false）也按店兜底进 errs，
          // 否则 Promise.all 整体 reject 会丢掉另一 worker 已拉到的结果
          try {
            const r = await getTemuAdPlansAction({ store: s.id })
            if (r.ok) out.push(...r.rows.map((p) => ({ ...p, storeId: s.id, storeName: s.name })))
            else errs.push(`${s.name}：${r.error}`)
          } catch (e) {
            errs.push(`${s.name}：${e instanceof Error ? e.message : "请求异常"}`)
          }
        }
      }
      await Promise.all([worker(), worker()])
      setPlans(out)
      // 截断放宽到 800：单店错误最长 300 字符（toWorkbenchError），两店即可能
      // 超 300——原先会把 230012000 的处置指引文案截掉，用户看不到修复提示
      setError(errs.length > 0 ? `部分店铺加载失败——${errs.join("；").slice(0, 800)}` : null)
    })
  }, [store, stores])

  React.useEffect(load, [load])

  // 双源并集：报表行 ∪ 注册表行，按 (店铺, productId) 对齐，花费降序（无数据的注册表行沉底）
  const merged = React.useMemo(() => {
    const byKey = new Map<string, MergedAdRow>()
    for (const r of reportRows) {
      // 组键店铺段：报表行 storeId 为空（temu_product 未反查到归属）时回落当前
      // 选中店，单店视图下才能与该店注册表行对齐；全店视图 store 为空维持空串
      const key = `${r.storeId ?? store ?? ""}:${r.productId}`
      byKey.set(key, {
        rowKey: key,
        storeId: r.storeId,
        storeName: r.storeName,
        productId: r.productId,
        mainImageUrl: r.mainImageUrl,
        mainImageCosUrl: r.mainImageCosUrl,
        productName: r.productName,
        productSn: r.productSn,
        plan: null,
        report: r,
      })
    }
    for (const p of plans) {
      const key = `${p.storeId}:${p.productId}`
      const cur = byKey.get(key)
      byKey.set(key, {
        rowKey: key,
        storeId: p.storeId,
        storeName: p.storeName,
        productId: p.productId,
        mainImageUrl: cur?.mainImageUrl ?? p.mainImageUrl,
        // 注册表行（官方实时接口）无转存 URL，仅报表行（temu_product 反查）有
        mainImageCosUrl: cur?.mainImageCosUrl ?? null,
        productName: cur?.productName ?? p.productName,
        productSn: cur?.productSn ?? p.productSn,
        plan: p,
        report: cur?.report ?? null,
      })
    }
    return [...byKey.values()].sort(
      (a, b) =>
        (b.report?.adSpend ?? b.plan?.spendFen ?? 0) -
        (a.report?.adSpend ?? a.plan?.spendFen ?? 0),
    )
  }, [reportRows, plans, store])

  // 状态筛选（逐状态动态：选项由当前数据实际出现的状态生成，带行数）
  const [statusFilter, setStatusFilter] = React.useState("all")
  const statusOptions = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of merged) {
      const label = row.plan?.adShowStatusLabel ?? "无实时状态"
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    // 推广中置顶 → 已暂停 → 其余按行数降序 → 纯报表行（无实时状态）沉底
    const rank = (label: string) =>
      label === "推广中" ? 0 : label === "已暂停" ? 1 : label === "无实时状态" ? 99 : 2
    return [...counts.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1])
  }, [merged])

  // 刷新后所选状态不再出现在选项里（如「推广中」清零）：回置全部，
  // 避免 Select 显示不在选项里的裸 label 且过滤恒空
  React.useEffect(() => {
    if (statusFilter !== "all" && !statusOptions.some(([label]) => label === statusFilter)) {
      setStatusFilter("all")
    }
  }, [statusOptions, statusFilter])

  // 客户端关键词过滤（不区分大小写包含匹配；空关键词=全部）+ 状态筛选叠加
  const visibleMerged = React.useMemo(() => {
    let list = merged
    if (statusFilter !== "all") {
      list = list.filter((row) => (row.plan?.adShowStatusLabel ?? "无实时状态") === statusFilter)
    }
    const kw = appliedSearch.keyword.trim().toLowerCase()
    if (!kw) return list
    return list.filter((row) => {
      const sn = row.productSn?.toLowerCase() ?? ""
      const name = row.productName?.toLowerCase() ?? ""
      switch (appliedSearch.field) {
        case "sn":
          return sn.includes(kw)
        case "name":
          return name.includes(kw)
        default:
          return sn.includes(kw) || name.includes(kw) || row.productId.toLowerCase().includes(kw)
      }
    })
  }, [merged, appliedSearch, statusFilter])

  // 刷新 = 服务端重取报表/大盘卡；注册表不显式 load——refresh 传入新建的 stores
  // 数组使 load 身份变化，useEffect(load,[load]) 自动重拉（显式调会每店拉两次）
  const refreshAll = () => {
    router.refresh()
  }

  // 窗口下拉跳转（近 7 日为缺省，不写 range 参数；与原 Link 切换口径一致）
  const rangeHref = (v: string) => {
    const p = new URLSearchParams()
    p.set("tab", "ads")
    if (v !== "7") p.set("range", v)
    if (urlStore) p.set("store", urlStore)
    return `/temu?${p.toString()}`
  }

  const onModify = async (
    row: PlanWithStore,
    action: "pause" | "open" | "budget" | "roas",
    value?: { budget?: number; roas?: number },
  ) => {
    setModifyPending(true)
    try {
      const r = await modifyTemuAdAction({
        store: row.storeId,
        productId: row.productId,
        action,
        ...value,
      })
      if (r.ok) {
        toast.success(
          `${store ? "" : `「${row.storeName}」`}商品 ${row.productName ?? row.productId} 广告已更新`,
        )
        setModifying(null)
        load()
      } else {
        toast.error(r.error ?? "操作失败", { duration: 8000 })
      }
    } catch (e) {
      // action 内权限校验等以 throw 结束（不走 {ok:false} 分支）：提示错误并
      // 复位 pending，确认弹窗按钮恢复可用可重试/取消，不静默失败
      toast.error(e instanceof Error ? e.message : "操作失败", { duration: 8000 })
    } finally {
      setModifyPending(false)
    }
  }

  return (
    // base-ui Tooltip 必须有 Provider 才会显示（缺 Provider 悬浮静默不弹）
    <TooltipProvider>
      <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">商品推广报表（{visibleMerged.length}）</CardTitle>
        {/* 创建广告 / 搜索 / 窗口下拉 / 刷新 同一行 */}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" className="h-8 text-xs" onClick={() => setCreating(true)}>
            <Megaphone className="size-3.5" /> 创建广告
          </Button>
          <TemuSearchBar
            fields={ADS_SEARCH_FIELDS}
            field={searchField}
            onFieldChange={setSearchField}
            keyword={searchKeyword}
            onKeywordChange={setSearchKeyword}
            onSearch={(f, kw) => {
              setSearchField(f)
              setAppliedSearch({ field: f, keyword: kw })
            }}
            searching={loading}
            className="w-72"
          />
          {/* 状态筛选（逐状态动态，客户端过滤与搜索叠加；纯报表行归「无实时状态」） */}
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "all")}>
            <SelectTrigger className="h-8 w-32 text-xs" aria-label="状态筛选">
              <SelectValue>
                {statusFilter === "all" ? `全部状态（${merged.length}）` : statusFilter}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态（{merged.length}）</SelectItem>
              {statusOptions.map(([label, n]) => (
                <SelectItem key={label} value={label}>
                  {label}（{n}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(range)} onValueChange={(v) => v && router.push(rangeHref(v))}>
            {/* base-ui SelectValue 默认渲染原始 value（1/7/30），须传 children 显示中文 */}
            <SelectTrigger className="h-8 w-28 text-xs" aria-label="统计窗口切换">
              <SelectValue>{range === 1 ? "今日" : `近 ${range} 日`}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">今日</SelectItem>
              <SelectItem value="7">近 7 日</SelectItem>
              <SelectItem value="30">近 30 日</SelectItem>
            </SelectContent>
          </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={refreshAll}
              disabled={loading}
              aria-label="刷新商品推广报表"
            >
              {loading ? <DashRing className="size-4" /> : <RefreshCw className="size-4" />}
              刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-auto scrollbar-hide">
          {/* 部分店铺扇出失败：横幅提示，已成功的店照常展示 */}
          {error && plans.length > 0 && (
            <p className="mb-2 rounded-md bg-red-500/10 px-2.5 py-1.5 text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          {error && plans.length === 0 && !loading ? (
            <p className="py-8 text-center text-sm text-red-600 dark:text-red-400">{error}</p>
          ) : (
            // overflow-clip 只按圆角裁剪（非滚动容器，sticky 表头仍锚定页侧 CardContent）
            <div className="w-max min-w-full overflow-clip rounded-md border">
            <table className="w-max min-w-full caption-bottom text-xs [&_td:not(:first-child)]:border-l [&_td:not(:first-child)]:border-border">
              <TableHeader className={TEMU_TABLE_HEADER_CLASS}>
                <TableRow>
                  <TableHead>主图</TableHead>
                  <TableHead>商品</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>日预算</TableHead>
                  <TableHead>目标 ROAS</TableHead>
                  <TableHead>花费</TableHead>
                  <TableHead>申报价销售额</TableHead>
                  <TableHead>ROAS</TableHead>
                  <TableHead>每笔成交花费</TableHead>
                  <TableHead>件数</TableHead>
                  <TableHead>
                    {/* 官方数据面限制：报表行推广维（无前缀）曝光/点击恒空，仅全域 total* 有值 */}
                    <Tooltip>
                      <TooltipTrigger className="cursor-default">曝光 / 点击</TooltipTrigger>
                      <TooltipContent className="text-xs">
                        官方仅提供全域口径（含自然流量）；花费 / 销售额为推广口径
                      </TooltipContent>
                    </Tooltip>
                  </TableHead>
                  <TableHead>店铺</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* 数据未齐一律整表骨架（首载/全店扇出/刷新），完成后一次性显示 */}
                {loading ? (
                  <TableSkeletonRows rows={8} cols={13} />
                ) : visibleMerged.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={13} className="h-20 text-center text-muted-foreground">
                      {/* 空态按生效筛选项提示清除方向：关键词 / 状态筛选 / 无筛选 */}
                      {appliedSearch.keyword.trim()
                        ? statusFilter !== "all"
                          ? "未找到匹配的广告商品，可清除关键词或切换状态后重试"
                          : "未找到匹配的广告商品，可清除关键词后重试"
                        : statusFilter !== "all"
                          ? "当前状态筛选下暂无广告，可切换状态后重试"
                          : "暂无在售广告——在售商品中的官方投放（含后台创建）将实时展示在此"}
                    </TableCell>
                  </TableRow>
                ) : (
                  visibleMerged.map((row) => (
                  <TableRow key={row.rowKey}>
                    <TableCell>
                      {row.mainImageUrl ? (
                        <ZoomableImage src={temuImageSrc(row.mainImageCosUrl, row.mainImageUrl)} className="size-10 rounded object-cover" />
                      ) : (
                        <div className="size-10 rounded bg-muted" />
                      )}
                    </TableCell>
                    <TableCell className="max-w-56">
                      <TruncTip text={row.productName ?? ""} className="max-w-56 font-medium" />
                      {/* 货号（缺省回落 SPU/productId）+ SKC（报表行 temu_product 反查带出） */}
                      <TruncTip
                        text={`${row.productSn ?? row.productId}${
                          row.report?.productSkcId ? ` · SKC ${row.report.productSkcId}` : ""
                        }`}
                        className="max-w-56 font-mono text-xs text-muted-foreground"
                      />
                    </TableCell>
                    <TableCell>
                      {row.plan ? (
                        <Badge
                          className={cn(
                            "rounded-[4px]",
                            AD_STATUS_TONE_CLS[TEMU_AD_STATUS_TONE[row.plan.adShowStatus ?? -1] ?? "gray"],
                          )}
                        >
                          {row.plan.adShowStatusLabel}
                        </Badge>
                      ) : (
                        <EmptyHint />
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {row.plan ? yuan(row.plan.budget) : <EmptyHint />}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {row.plan?.roas != null ? fmtRoas(row.plan.roas) : <EmptyHint />}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {(row.report?.adSpend ?? row.plan?.spendFen) != null
                        ? yuan(row.report?.adSpend ?? row.plan?.spendFen)
                        : <EmptyHint />}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {(row.report?.orderPayAmt ?? row.plan?.orderPayAmtFen) != null
                        ? yuan(row.report?.orderPayAmt ?? row.plan?.orderPayAmtFen)
                        : <EmptyHint />}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {row.report?.roas != null ? row.report.roas.toFixed(2) : (row.plan?.roasSummary != null ? fmtRoas(row.plan.roasSummary) : <EmptyHint />)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {(row.report?.transactionCost ?? row.plan?.transactionCostFen) != null
                        ? yuan(row.report?.transactionCost ?? row.plan?.transactionCostFen)
                        : <EmptyHint />}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {(row.report?.goodsNum ?? row.plan?.goodsNum) != null
                        ? num(row.report?.goodsNum ?? row.plan?.goodsNum)
                        : <EmptyHint />}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {(row.report?.imprCnt ?? row.plan?.imprCnt) != null
                        ? num(row.report?.imprCnt ?? row.plan?.imprCnt)
                        : <EmptyHint />}{" "}
                      /{" "}
                      {(row.report?.clkCnt ?? row.plan?.clkCnt) != null
                        ? num(row.report?.clkCnt ?? row.plan?.clkCnt)
                        : <EmptyHint />}
                    </TableCell>
                    <TableCell className="max-w-24">
                      <span className="truncate text-xs">{row.storeName ?? <EmptyHint />}</span>
                    </TableCell>
                    <TableCell>
                      {row.plan ? (
                        // 四个操作收纳为单个「操作」下拉（原四按钮占宽过高）
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs"
                                aria-label="广告操作"
                              />
                            }
                          >
                            <MoreHorizontal className="size-3.5" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="min-w-28">
                            <DropdownMenuItem onClick={() => setModifying({ row: row.plan!, action: "budget" })}>
                              改预算
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setModifying({ row: row.plan!, action: "roas" })}>
                              改 ROAS
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setModifying({ row: row.plan!, action: "pause" })}>
                              <Pause className="size-3.5" /> 暂停
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setModifying({ row: row.plan!, action: "open" })}>
                              <Play className="size-3.5" /> 开启
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                  ))
                )}
              </TableBody>
            </table>
            </div>
          )}
        </CardContent>
        {/* 弹窗为 Portal 渲染，挂在 Card 内不影响布局 */}
        {creating && (
          <CreateAdsDialog
            store={store}
            stores={stores}
            onClose={() => setCreating(false)}
            onDone={() => {
              setCreating(false)
              refreshAll()
            }}
          />
        )}
        {modifying && (
          <ModifyAdDialog
            modifying={modifying}
            pending={modifyPending}
            onCancel={() => setModifying(null)}
            onSubmit={(value) => onModify(modifying.row, modifying.action, value)}
          />
        )}
      </Card>
    </TooltipProvider>
  )
}

/* ─── 创建广告弹窗：选商品（可投性前置校验）+ 日预算 + 目标 ROAS ─── */

function CreateAdsDialog({
  store: storeProp,
  stores,
  onClose,
  onDone,
}: {
  /** 已选店铺；undefined=全部店铺视图（弹窗内选店，默认第一店） */
  store?: string
  stores: { id: string; name: string }[]
  onClose: () => void
  onDone: () => void
}) {
  // 全部店铺视图：弹窗内先选店铺（官方创建/校验接口都按单店 token 调用）
  const [selectedStore, setSelectedStore] = React.useState<string>(storeProp ?? stores[0]?.id ?? "")
  const store = selectedStore
  const [products, setProducts] = React.useState<TemuAdProductRow[]>([])
  /** 官方灰名单为空（未返回校验数据）：徽章降级「在售」+提示以提交校验为准 */
  const [grayListEmpty, setGrayListEmpty] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [q, setQ] = React.useState("")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [budgetYuan, setBudgetYuan] = React.useState("")
  const [roas, setRoas] = React.useState("")
  /** 用户是否手动改过 ROAS（改过后自动推荐不覆盖，刷新按钮仍可强制） */
  const roasDirtyRef = React.useRef(false)
  /** 自动推荐只触发一次（广告接口组频控紧，不逐次选中重查） */
  const autoQueriedRef = React.useRef(false)
  const [roasPending, startRoas] = React.useTransition()
  const [loading, startLoading] = React.useTransition()
  const [submitting, setSubmitting] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)
  const [result, setResult] = React.useState<
    | { successCount: number; alreadyCount: number; fails: { productId: string; reason: string | null }[] }
    | null
  >(null)

  const load = React.useCallback(() => {
    startLoading(async () => {
      const r = await listTemuAdProductsAction({ store, q: q || undefined })
      if (r.ok) {
        setProducts(r.rows)
        setGrayListEmpty(r.grayListEmpty)
        setError(null)
      } else {
        setProducts([])
        setError(r.error)
      }
    })
  }, [store, q])

  React.useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0)
    return () => clearTimeout(t)
  }, [load, q])

  // 切换店铺：清选择与结果（商品清单/可投性按店重查），推荐 ROAS 重新预填
  React.useEffect(() => {
    setSelected(new Set())
    setResult(null)
    autoQueriedRef.current = false
  }, [store])

  /** 查官方推荐 ROAS（ad.roas.pred）；失败/为空回落默认 13，不阻断创建 */
  const queryPredRoas = (ids: string[], force: boolean) => {
    startRoas(async () => {
      const r = await predictTemuAdRoasAction({ store, productIds: ids })
      if (force || !roasDirtyRef.current) setRoas(String(r.roas ?? 13))
    })
  }

  const toggle = (pid: string) => {
    const next = new Set(selected)
    if (next.has(pid)) next.delete(pid)
    else next.add(pid)
    setSelected(next)
    // 选中即自动查一次推荐 ROAS 预填（频控组只查一次；用户改过则只经「查推荐」）。
    // 放事件处理器而非 effect：切店重置与查询 effect 同 commit 时闭包里 selected
    // 仍是旧店选中集，会拿新店 token 查旧店商品且消费掉 autoQueriedRef
    if (next.size > 0 && !autoQueriedRef.current && !roasDirtyRef.current) {
      autoQueriedRef.current = true
      queryPredRoas([...next], false)
    }
  }

  // 日预算留空=不限（官方 ad.create 口径传 -1）；填了则须为正数
  const budgetUnlimited = budgetYuan.trim() === ""
  const budgetFen = budgetUnlimited ? -1 : Math.round(Number(budgetYuan) * 100)
  const roasVal = Number(roas)
  const canSubmit =
    selected.size > 0 &&
    (budgetUnlimited || (Number.isFinite(budgetFen) && budgetFen > 0)) &&
    Number.isFinite(roasVal) &&
    roasVal > 0

  const submit = async () => {
    setSubmitting(true)
    try {
      const items = [...selected].map((productId) => ({
        productId,
        budget: budgetFen,
        roas: roasVal,
      }))
      const r = await createTemuAdsAction({ store, items })
      if (r.ok) {
        setResult({ successCount: r.successCount, alreadyCount: r.alreadyCount, fails: r.fails })
        if (r.successCount > 0) toast.success(`已创建 ${r.successCount} 个商品的广告`)
        setConfirming(false)
      } else {
        toast.error(r.error, { duration: 10000 })
        setConfirming(false)
      }
    } catch (e) {
      // action 内权限校验等以 throw 结束：提示错误并关闭确认弹窗，主弹窗保留可重试
      toast.error(e instanceof Error ? e.message : "操作失败", { duration: 10000 })
      setConfirming(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      {/* sm: 前缀必带：无前缀 max-w-* 会被基础类 sm:max-w-sm 压住（弹窗过窄） */}
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>创建广告（官方 API）</DialogTitle>
          <DialogDescription>
            通过官方 API 创建的商品推广广告——仅此类广告的数据可回读展示。日预算留空=不限；
            目标 ROAS 为数值，选中商品后自动填入官方推荐（失败回落 13）。仅展示在售商品。
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <p className="text-sm">
              创建成功 <b>{result.successCount}</b> 个
              {result.alreadyCount > 0 && <>，此前已创建 {result.alreadyCount} 个</>}
              {result.fails.length > 0 && <>，失败 {result.fails.length} 个：</>}
            </p>
            {result.fails.length > 0 && (
              <div className="max-h-56 space-y-1.5 overflow-y-auto">
                {result.fails.map((f) => (
                  <div key={f.productId} className="flex items-start gap-2 rounded-md bg-muted/60 px-2.5 py-1.5 text-xs">
                    <span className="font-mono text-muted-foreground">{f.productId}</span>
                    <span className="text-red-600 dark:text-red-400">{f.reason ?? "未知原因"}</span>
                  </div>
                ))}
              </div>
            )}
            <DialogFooter>
              <Button onClick={onDone}>完成</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            {/* 全部店铺视图：创建/校验接口按单店 token 调用，先选店铺 */}
            {!storeProp && (
              <div className="space-y-1">
                <Label className="text-xs">店铺</Label>
                <Select
                  items={stores.map((s) => ({ value: s.id, label: s.name }))}
                  value={store}
                  onValueChange={(v) => v && setSelectedStore(v)}
                >
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue placeholder="选择店铺" />
                  </SelectTrigger>
                  <SelectContent>
                    {stores.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs">商品（可投性实时校验）</Label>
              <Input
                className="h-8 text-xs"
                placeholder="搜索商品名 / 货号"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
              {/* 官方灰名单为空（五真店实测恒空，疑 API 通道广告协议未生效）：
                  无法逐商品校验可投性，列表=在售商品，创建时官方逐一校验 */}
              {!error && grayListEmpty && products.length > 0 && (
                <p className="rounded-sm bg-muted/60 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  官方可投校验接口未返回数据：已列出全部在售商品，提交创建时官方将逐商品校验，不可投的商品会返回原因
                </p>
              )}
              {error ? (
                <p className="py-6 text-center text-xs text-red-600 dark:text-red-400">{error}</p>
              ) : loading && products.length === 0 ? (
                <p className="flex items-center justify-center gap-1.5 py-6 text-xs text-muted-foreground">
                  <DashRing className="size-3.5" />
                  加载中…
                </p>
              ) : products.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  未找到可投商品（店铺商品由定时同步维护；商品需在售且未在线推广方可创建，可尝试更换搜索词）
                </p>
              ) : (
                // 服务端已过滤不可投商品（2026-11-17 口径），这里只剩可投/已创建
                products.map((p) => (
                  <label
                    key={p.productId}
                    className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/60"
                  >
                    <Checkbox
                      checked={selected.has(p.productId)}
                      onCheckedChange={() => toggle(p.productId)}
                      aria-label={`选择 ${p.productName ?? p.productId}`}
                    />
                    {p.mainImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.mainImageUrl} alt="" className="size-8 rounded object-cover" loading="lazy" />
                    ) : (
                      <div className="size-8 rounded bg-muted" />
                    )}
                    <span className="min-w-0 flex-1">
                      <TruncTip text={p.productName ?? ""} className="max-w-80 font-medium" />
                      <span className="block max-w-80 truncate font-mono text-[11px] text-muted-foreground">
                        {p.productSn ?? p.productId}
                      </span>
                    </span>
                    {p.advertised ? (
                      <Badge className="rounded-[4px] bg-blue-500/15 text-blue-700 dark:text-blue-400">已创建</Badge>
                    ) : grayListEmpty ? (
                      /* 灰名单空=官方未校验，只承诺「在售」不承诺「可投」 */
                      <Badge className="rounded-[4px] bg-muted text-muted-foreground">在售</Badge>
                    ) : (
                      <Badge className="rounded-[4px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">可投</Badge>
                    )}
                  </label>
                ))
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">日预算（元 / 全部选中商品，留空=不限）</Label>
                <Input
                  className="h-8 text-xs"
                  inputMode="decimal"
                  placeholder="留空不限，如 50"
                  value={budgetYuan}
                  onChange={(e) => setBudgetYuan(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">目标 ROAS</Label>
                  {/* 频控组：自动预填仅一次，这里按当前选中强制重查官方推荐 */}
                  <button
                    type="button"
                    className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-60"
                    disabled={roasPending || selected.size === 0}
                    onClick={() => queryPredRoas([...selected], true)}
                  >
                    <RefreshCw className={cn("size-3", roasPending && "animate-spin")} />
                    查推荐
                  </button>
                </div>
                <Input
                  className="h-8 text-xs"
                  inputMode="decimal"
                  placeholder="官方推荐，默认 13"
                  value={roas}
                  onChange={(e) => {
                    roasDirtyRef.current = true
                    setRoas(e.target.value)
                  }}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={submitting}>
                取消
              </Button>
              <Button disabled={!canSubmit || submitting} onClick={() => setConfirming(true)}>
                创建（{selected.size} 个商品）
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>

      {confirming && (
        <ConfirmDialog
          open
          title="确认创建广告"
          description={`将为 ${selected.size} 个商品创建官方广告，日预算 ${budgetUnlimited ? "不限" : `¥${budgetYuan}`} / 商品，目标 ROAS ${roas}。创建后立即生效并产生真实花费，请确认。`}
          confirmText="确认创建"
          pending={submitting}
          onConfirm={submit}
          onOpenChange={(v) => !v && setConfirming(false)}
        />
      )}
    </Dialog>
  )
}

/* ─── 修改弹窗：改预算 / 改目标 ROAS（暂停/开启走二次确认） ─── */

function ModifyAdDialog({
  modifying,
  pending,
  onCancel,
  onSubmit,
}: {
  modifying: { row: TemuAdPlanRow; action: "pause" | "open" | "budget" | "roas" }
  /** 提交请求进行中：确认按钮禁用（防连点重复提交官方写操作） */
  pending: boolean
  onCancel: () => void
  onSubmit: (value: { budget?: number; roas?: number }) => void
}) {
  const [value, setValue] = React.useState("")
  const [confirming, setConfirming] = React.useState(false)
  const isPause = modifying.action === "pause"
  const isOpen = modifying.action === "open"
  const isValue = modifying.action === "budget" || modifying.action === "roas"
  const numVal = Number(value)
  const valid = Number.isFinite(numVal) && numVal > 0

  return (
    <>
      <Dialog open={isValue} onOpenChange={(v) => !v && onCancel()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {modifying.action === "budget" ? "修改日预算" : "修改目标 ROAS"}
            </DialogTitle>
            <DialogDescription>
              商品：{modifying.row.productName ?? modifying.row.productId}
              {modifying.action === "budget"
                ? `，当前 ${yuan(modifying.row.budget)}`
                : `，当前 ${fmtRoas(modifying.row.roas)}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label className="text-xs">{modifying.action === "budget" ? "新日预算（元）" : "新目标 ROAS"}</Label>
            <Input
              className="h-8 text-xs"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onCancel}>取消</Button>
            <Button
              disabled={!valid}
              onClick={() => setConfirming(true)}
            >
              确认修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {(isPause || isOpen) && (
        <ConfirmDialog
          open
          title={isPause ? "暂停广告" : "开启广告"}
          description={`${isPause ? "暂停" : "开启"}商品「${modifying.row.productName ?? modifying.row.productId}」的广告投放？`}
          confirmText={isPause ? "确认暂停" : "确认开启"}
          pending={pending}
          onConfirm={() => onSubmit({})}
          onOpenChange={(v) => !v && onCancel()}
        />
      )}

      {isValue && confirming && (
        <ConfirmDialog
          open
          title={modifying.action === "budget" ? "确认修改日预算" : "确认修改目标 ROAS"}
          description={
            modifying.action === "budget"
              ? `商品「${modifying.row.productName ?? modifying.row.productId}」日预算将改为 ¥${value}，立即生效。`
              : `商品「${modifying.row.productName ?? modifying.row.productId}」目标 ROAS 将改为 ${value}，立即生效。`
          }
          confirmText="确认"
          pending={pending}
          onConfirm={() =>
            onSubmit(
              modifying.action === "budget"
                ? { budget: Math.round(numVal * 100) }
                : { roas: numVal },
            )
          }
          onOpenChange={(v) => !v && setConfirming(false)}
        />
      )}
    </>
  )
}
