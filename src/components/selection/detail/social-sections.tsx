"use client"

import * as React from "react"
import { BadgeCheck, ExternalLink } from "lucide-react"
import { SmartImage } from "@/components/ui/smart-image"
import { Chips, Section } from "@/components/selection/detail/detail-shared"
import { compactNumber, formatDuration } from "@/components/selection/labels"
import type { SelectionPoolItem } from "@/lib/selection/pool-types"
import { cn } from "@/lib/utils"

/**
 * 社媒详情的平台专属分区：正文全文（可展开）+ 作者卡 + 各平台自己的元信息
 * （TikTok 音乐 / 带货、Instagram 位置 / 音乐、Pinterest 画板、Reddit 版块 / 赞成比、
 * X 引用 / 书签…）+ 话题标签。
 */

interface MetaRow {
  label: string
  value: React.ReactNode
}

function MetaList({ rows }: { rows: MetaRow[] }) {
  if (rows.length === 0) return null
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {rows.map((r) => (
        <React.Fragment key={r.label}>
          <dt className="text-muted-foreground">{r.label}</dt>
          <dd className="min-w-0 break-words">{r.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

function pct(v: number | null | undefined): string | null {
  return v != null && v > 0 ? `${Math.round(v * 100)}%` : null
}

/** 作者卡：头像 + 名称 + 认证 + 粉丝数 */
function AuthorCard({ item }: { item: SelectionPoolItem }) {
  const ex = item.extras ?? {}
  let data: { name: string; handle: string | null; avatar: string | null; verified: boolean; followers: number | null; extra: string | null } | null = null
  if (item.platform === "tiktok" && ex.tiktok?.author) {
    data = {
      name: ex.tiktok.author.nickname || ex.tiktok.author.username,
      handle: `@${ex.tiktok.author.username}`,
      avatar: ex.tiktok.author.avatar,
      verified: ex.tiktok.author.verified,
      followers: ex.tiktok.author.followers,
      extra: null,
    }
  } else if (item.platform === "x" && ex.x?.author) {
    data = {
      name: ex.x.author.name || ex.x.author.username,
      handle: `@${ex.x.author.username}`,
      avatar: ex.x.author.avatar,
      verified: ex.x.author.verified,
      followers: ex.x.author.followers,
      extra: null,
    }
  } else if (item.platform === "pinterest") {
    data = {
      name: ex.pinterest?.pinnerName || item.sellerName || "",
      handle: item.sellerName,
      avatar: null,
      verified: false,
      followers: ex.pinterest?.pinnerFollowers ?? null,
      extra: ex.pinterest?.boardName ?? null,
    }
  } else if (item.platform === "reddit") {
    data = {
      name: item.sellerName ? `u/${item.sellerName}` : "",
      handle: null,
      avatar: null,
      verified: false,
      followers: null,
      extra: item.category ? `r/${item.category}` : null,
    }
  } else if (item.sellerName) {
    data = { name: item.sellerName, handle: null, avatar: null, verified: false, followers: null, extra: null }
  }
  if (!data || !data.name) return null
  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-muted/40 p-2.5">
      {data.avatar ? (
        <SmartImage src={data.avatar} alt="" className="size-9 shrink-0 rounded-full border object-cover" />
      ) : (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
          {data.name.replace(/^[@u/]+/, "").slice(0, 1).toUpperCase()}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 truncate text-sm font-medium">
          {data.name}
          {data.verified ? <BadgeCheck className="size-3.5 shrink-0 text-sky-500" aria-label="认证作者" /> : null}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          {[data.handle, data.followers != null ? `粉丝 ${compactNumber(data.followers)}` : null, data.extra]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
    </div>
  )
}

export function SocialSections({ item }: { item: SelectionPoolItem }) {
  const ex = item.extras ?? {}
  const content = item.content ?? ""
  const [expanded, setExpanded] = React.useState(false)
  React.useEffect(() => setExpanded(false), [item.id])
  const long = content.length > 260 || content.split("\n").length > 6

  const link = (url: string | null | undefined, text?: string) =>
    url ? (
      <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
        {text ?? url}
        <ExternalLink className="size-3" />
      </a>
    ) : null

  const rows: MetaRow[] = []
  switch (item.platform) {
    case "tiktok": {
      const t = ex.tiktok
      if (t?.durationSec != null) rows.push({ label: "时长", value: formatDuration(t.durationSec) })
      if (t?.definition) rows.push({ label: "清晰度", value: t.definition })
      if (t?.music) rows.push({ label: "音乐", value: `${t.music.name}${t.music.author ? ` · ${t.music.author}` : ""}` })
      if (t?.location) rows.push({ label: "位置", value: t.location })
      if (t?.language) rows.push({ label: "语言", value: t.language })
      if (t?.hasShopProduct) rows.push({ label: "商品", value: "视频挂有 TikTok Shop 商品" })
      break
    }
    case "instagram": {
      const ig = ex.instagram
      if (ig?.type) rows.push({ label: "类型", value: ig.type === "Sidecar" ? "多图轮播" : ig.type })
      if (ig?.durationSec != null) rows.push({ label: "时长", value: formatDuration(ig.durationSec) })
      if (ig?.location) rows.push({ label: "位置", value: ig.location })
      if (ig?.music) rows.push({ label: "音乐", value: `${ig.music.name}${ig.music.artist ? ` · ${ig.music.artist}` : ""}` })
      if (ig?.coauthors.length) rows.push({ label: "联合作者", value: ig.coauthors.map((c) => `@${c}`).join("、") })
      if (ig?.paidPartnership) rows.push({ label: "标记", value: "商务合作内容" })
      break
    }
    case "pinterest": {
      const p = ex.pinterest
      if (p?.boardName) rows.push({ label: "画板", value: link(p.boardUrl, p.boardName) ?? p.boardName })
      if (p?.domain && p.domain !== "Uploaded by user") rows.push({ label: "来源", value: p.domain })
      if (p?.outboundLink) rows.push({ label: "外链", value: link(p.outboundLink, p.domain || "访问来源网站") })
      if (p?.durationSec != null) rows.push({ label: "时长", value: formatDuration(p.durationSec) })
      break
    }
    case "reddit": {
      const r = ex.reddit
      if (item.category) rows.push({ label: "版块", value: `r/${item.category}` })
      if (r?.flair) rows.push({ label: "标签", value: r.flair })
      const ratio = pct(r?.upvoteRatio)
      if (ratio) rows.push({ label: "赞成比", value: ratio })
      if (r?.awards) rows.push({ label: "奖章", value: `${r.awards} 个` })
      if (r?.domain && r.domain !== "reddit.com") rows.push({ label: "链接", value: link(r.outboundUrl, r.domain) })
      if (r?.isNsfw) rows.push({ label: "提示", value: "NSFW 内容" })
      break
    }
    case "x": {
      const x = ex.x
      if (x?.quoteCount != null) rows.push({ label: "引用", value: compactNumber(x.quoteCount) })
      if (x?.bookmarkCount != null) rows.push({ label: "书签", value: compactNumber(x.bookmarkCount) })
      if (x?.lang) rows.push({ label: "语言", value: x.lang })
      if (x?.place) rows.push({ label: "地点", value: x.place })
      if (x?.isReply) rows.push({ label: "类型", value: "回复推文" })
      break
    }
    default:
      break
  }

  return (
    <>
      {content ? (
        <div>
          <p
            className={cn(
              "text-sm leading-relaxed whitespace-pre-wrap break-words",
              !expanded && long && "line-clamp-[8]",
            )}
          >
            {content}
          </p>
          {long ? (
            <button
              type="button"
              className="mt-1 text-[11px] text-primary hover:underline"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "收起" : "展开全文"}
            </button>
          ) : null}
        </div>
      ) : null}

      <AuthorCard item={item} />

      {rows.length > 0 ? (
        <Section title="详细信息">
          <MetaList rows={rows} />
        </Section>
      ) : null}

      {item.hashtags?.length ? (
        <Section title="话题">
          <Chips items={item.hashtags} max={20} />
        </Section>
      ) : null}
    </>
  )
}
