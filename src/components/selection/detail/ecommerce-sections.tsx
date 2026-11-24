"use client"

import * as React from "react"
import { ExternalLink, Layers, MessageSquareQuote, Package, Star, Tags, Truck } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Chips, Kv, Section } from "@/components/selection/detail/detail-shared"
import { compactNumber } from "@/components/selection/labels"
import type { SelectionPoolItem } from "@/lib/selection/pool-types"
import { cn } from "@/lib/utils"

/**
 * 电商详情的平台专属分区（数据来自服务端从 raw_data 投影的 extras，存量行无需重抓）：
 *   Amazon：卖点 / 排名 / 评分分布 / 官方 AI 评论摘要 / 规格属性 / 变体 / 配送库存
 *   TEMU：店铺 / 规格 / 退货 / SKU
 *   Etsy：类目 / 标签 / 材质 / 店铺；Shopify：类目 / 标签 / 店铺
 */

function RatingBars({ breakdown }: { breakdown: number[] }) {
  // breakdown[0] = 5 星 … [4] = 1 星
  return (
    <div className="space-y-1">
      {breakdown.map((pct, i) => (
        <div key={i} className="flex items-center gap-2 text-[11px]">
          <span className="w-8 shrink-0 text-muted-foreground">{5 - i} 星</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-amber-400" style={{ width: `${pct}%` }} />
          </div>
          <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">{pct}%</span>
        </div>
      ))}
    </div>
  )
}

function AmazonSections({ item }: { item: SelectionPoolItem }) {
  const ex = item.extras?.amazon
  if (!ex) return null
  return (
    <>
      {ex.features.length > 0 ? (
        <Section title="卖点（五点描述）" icon={<Package className="size-3.5 text-primary" />}>
          <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed">
            {ex.features.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {ex.listPosition != null || ex.bsrRanks.length > 0 || ex.searchPosition != null ? (
        <Section title="排名">
          <div className="space-y-1 text-xs">
            {ex.listPosition != null ? (
              <p>
                <span className="font-medium text-amber-600 dark:text-amber-400">榜单第 {ex.listPosition} 名</span>
                {ex.listCategory ? <span className="text-muted-foreground"> · {ex.listCategory}</span> : null}
              </p>
            ) : null}
            {ex.bsrRanks.map((r) => (
              <p key={r.category}>
                <span className="font-medium">BSR #{r.rank}</span>
                <span className="text-muted-foreground"> · {r.category}</span>
              </p>
            ))}
            {ex.searchPosition != null ? (
              <p className="text-muted-foreground">关键词搜索结果第 {ex.searchPosition} 位</p>
            ) : null}
          </div>
        </Section>
      ) : null}

      {ex.ratingBreakdown.length === 5 ? (
        <Section title="评分分布" icon={<Star className="size-3.5 text-primary" />}>
          <RatingBars breakdown={ex.ratingBreakdown} />
        </Section>
      ) : null}

      {ex.aiReviewSummary ? (
        <Section title="顾客说（Amazon 官方 AI 评论摘要）" icon={<MessageSquareQuote className="size-3.5 text-primary" />}>
          <p className="text-xs leading-relaxed">{ex.aiReviewSummary.text}</p>
          <div className="flex flex-wrap gap-1">
            {ex.aiReviewSummary.keywords.map((k) => {
              const chipClassName = cn(
                "rounded px-1.5 py-0.5 text-[10px]",
                k.sentiment === "positive" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                k.sentiment === "negative" && "bg-red-500/10 text-red-700 dark:text-red-400",
                k.sentiment !== "positive" && k.sentiment !== "negative" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
              )
              // 有提及数拆解才需要悬浮提示（正/负提及数只存在于提示里）
              if (k.total == null) {
                return (
                  <span key={k.name} className={chipClassName}>
                    {k.name}
                  </span>
                )
              }
              return (
                <Tooltip key={k.name}>
                  <TooltipTrigger render={<span className={chipClassName} />}>
                    {k.name}
                    <span className="ml-1 opacity-70">{k.total}</span>
                  </TooltipTrigger>
                  <TooltipContent>提及 {k.total} 次：正面 {k.positive ?? 0} / 负面 {k.negative ?? 0}</TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        </Section>
      ) : null}

      {ex.attributes.length > 0 ? (
        <Section title="规格属性" icon={<Tags className="size-3.5 text-primary" />}>
          <Kv items={ex.attributes} />
        </Section>
      ) : null}

      {ex.variants.length > 0 ? (
        <Section title="变体" icon={<Layers className="size-3.5 text-primary" />}>
          <div className="flex flex-wrap gap-1">
            {ex.variants.map((v) => (
              <Tooltip key={v.asin}>
                <TooltipTrigger
                  render={
                    <span
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[10px]",
                        v.asin === ex.asin ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground",
                      )}
                    />
                  }
                >
                  {v.name}
                  {v.price != null ? ` · ${v.price}` : ""}
                </TooltipTrigger>
                <TooltipContent>变体 ASIN：{v.asin}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </Section>
      ) : null}

      {ex.delivery || ex.fastestDelivery || ex.inStock != null ? (
        <Section title="配送与库存" icon={<Truck className="size-3.5 text-primary" />}>
          <div className="space-y-0.5 text-xs text-muted-foreground">
            {ex.inStock != null ? <p>库存：{ex.inStock ? "有货" : "缺货"}</p> : null}
            {ex.fastestDelivery ? <p>最快送达：{ex.fastestDelivery}</p> : null}
            {ex.delivery ? <p>预计送达：{ex.delivery}</p> : null}
            {ex.videosCount != null && ex.videosCount > 0 ? <p>商品视频 {ex.videosCount} 个</p> : null}
          </div>
        </Section>
      ) : null}
    </>
  )
}

function TemuSections({ item }: { item: SelectionPoolItem }) {
  const ex = item.extras?.temu
  return (
    <>
      {ex?.salesTip || ex?.discountPct != null ? (
        <Section title="销量与优惠">
          <div className="space-y-0.5 text-xs text-muted-foreground">
            {ex.salesTip ? <p>{ex.salesTip}</p> : null}
            {ex.discountPct != null ? <p>降幅 {ex.discountPct}%</p> : null}
          </div>
        </Section>
      ) : null}
      {ex?.specifications.length ? (
        <Section title="规格属性" icon={<Tags className="size-3.5 text-primary" />}>
          <Kv items={ex.specifications} />
        </Section>
      ) : null}
      {ex?.skuCount || ex?.returnPolicy ? (
        <Section title="销售信息">
          <div className="space-y-0.5 text-xs text-muted-foreground">
            {ex.skuCount != null ? <p>SKU {ex.skuCount} 个</p> : null}
            {ex.returnPolicy ? (
              <p>
                退货：{ex.returnPolicy.returnWindowDays != null ? `${ex.returnPolicy.returnWindowDays} 天内` : ""}
                {ex.returnPolicy.freeReturns ? "（免费退货）" : ""}
              </p>
            ) : null}
            {ex.inStock != null ? <p>库存：{ex.inStock ? "有货" : "缺货"}</p> : null}
          </div>
        </Section>
      ) : null}
      {ex?.mallLink ? (
        <a
          href={ex.mallLink}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <ExternalLink className="size-3" />
          查看店铺
        </a>
      ) : null}
    </>
  )
}

function EtsySections({ item }: { item: SelectionPoolItem }) {
  const ex = item.extras?.etsy
  return (
    <>
      {item.categoryPath?.length ? (
        <Section title="类目">
          <p className="text-xs text-muted-foreground">{item.categoryPath.join(" / ")}</p>
        </Section>
      ) : null}
      {ex?.tags.length ? (
        <Section title="标签">
          <Chips items={ex.tags} />
        </Section>
      ) : null}
      {ex?.materials.length ? (
        <Section title="材质">
          <Chips items={ex.materials} />
        </Section>
      ) : null}
      {ex?.shopName || ex?.whenMade || ex?.shipsFromCountry ? (
        <Section title="店铺">
          <div className="space-y-0.5 text-xs text-muted-foreground">
            {ex?.shopName ? (
              <p>
                {ex.shopUrl ? (
                  <a href={ex.shopUrl} target="_blank" rel="noreferrer" className="text-foreground hover:underline">
                    {ex.shopName}
                  </a>
                ) : (
                  <span className="text-foreground">{ex.shopName}</span>
                )}
                {ex.shopRating != null ? <span> · 评分 {ex.shopRating.toFixed(1)}</span> : null}
              </p>
            ) : null}
            {ex?.whenMade ? <p>制作时间：{ex.whenMade}</p> : null}
            {ex?.shipsFromCountry ? <p>发货地：{ex.shipsFromCountry}</p> : null}
            {ex?.favorites != null ? <p>收藏 {compactNumber(ex.favorites)}</p> : null}
          </div>
        </Section>
      ) : null}
    </>
  )
}

function ShopifySections({ item }: { item: SelectionPoolItem }) {
  const ex = item.extras?.shopify
  return (
    <>
      {item.categoryPath?.length ? (
        <Section title="类目">
          <p className="text-xs text-muted-foreground">{item.categoryPath.join(" / ")}</p>
        </Section>
      ) : null}
      {ex?.tags.length ? (
        <Section title="标签">
          <Chips items={ex.tags} />
        </Section>
      ) : null}
      {ex?.retailer || ex?.brand ? (
        <Section title="店铺 / 品牌">
          <div className="space-y-0.5 text-xs text-muted-foreground">
            {ex?.retailer ? <p>店铺：{ex.retailer}</p> : null}
            {ex?.brand ? <p>品牌：{ex.brand}</p> : null}
            {ex?.fullyOutOfStock ? <p className="text-red-600 dark:text-red-400">全线售罄</p> : null}
          </div>
        </Section>
      ) : null}
    </>
  )
}

export function EcommerceSections({ item }: { item: SelectionPoolItem }) {
  switch (item.platform) {
    case "amazon":
      return <AmazonSections item={item} />
    case "temu":
      return <TemuSections item={item} />
    case "etsy":
      return <EtsySections item={item} />
    case "shopify":
      return <ShopifySections item={item} />
    default:
      return null
  }
}
