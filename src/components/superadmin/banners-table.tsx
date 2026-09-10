"use client"

import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ExternalLink } from "lucide-react"
import { BANNER_ICON_OPTIONS } from "@/lib/banner"
import {
  BannerEditButton,
  BannerToggleActiveButton,
  type BannerRow,
} from "@/components/superadmin/banner-form-dialog"
import { BannerDeleteButton } from "@/components/superadmin/banner-delete-dialog"
import { DragHandle, useDragSort } from "@/hooks/use-drag-sort"
import { reorderBannersAction } from "@/server/actions/platform-banners"

function formatTime(v: Date | null): string {
  return v ? new Date(v).toLocaleString("zh-CN") : "—"
}

/** 投放周期状态（与展示端筛选规则一致：结束即不再展示） */
function periodBadge(
  startsAt: Date | null,
  endsAt: Date | null,
): { label: string; variant: "default" | "secondary" | "destructive" | "outline" } {
  const now = Date.now()
  if (startsAt && new Date(startsAt).getTime() > now)
    return { label: "未开始", variant: "secondary" }
  if (endsAt && new Date(endsAt).getTime() <= now)
    return { label: "已结束", variant: "destructive" }
  if (!startsAt && !endsAt) return { label: "长期", variant: "outline" }
  return { label: "进行中", variant: "default" }
}

/**
 * 横幅列表（行首手柄拖拽排序）。
 *
 * 列表分页 20/页：拖拽仅作用于当前页子集，reorder 值重分配保证跨页
 * 相对顺序不变。搜索态下拖拽同样安全（子集值重分配）。
 */
export function BannersTable({
  items,
  emptyHint,
}: {
  items: BannerRow[]
  emptyHint: string
}) {
  const { ordered, rowProps, handleProps } = useDragSort({
    items,
    commit: (ids) => reorderBannersAction(ids),
  })
  const iconLabel = (icon: string) =>
    BANNER_ICON_OPTIONS.find((o) => o.value === icon)?.label ?? icon

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" aria-label="拖动排序" />
          <TableHead>标题 / 内容</TableHead>
          <TableHead>跳转链接</TableHead>
          <TableHead>投放周期</TableHead>
          <TableHead>倒计时截止</TableHead>
          <TableHead>状态</TableHead>
          <TableHead className="text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ordered.length === 0 ? (
          <TableRow>
            <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
              {emptyHint}
            </TableCell>
          </TableRow>
        ) : (
          ordered.map((b) => {
            const period = periodBadge(b.startsAt, b.endsAt)
            return (
              <TableRow key={b.id} {...rowProps(b.id)}>
                <TableCell className="w-8">
                  <DragHandle handleProps={handleProps(b.id)} />
                </TableCell>
                <TableCell className="max-w-72">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">
                      {b.title}
                    </p>
                    <Badge variant="outline">{iconLabel(b.icon)}</Badge>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {b.content}
                  </p>
                </TableCell>
                <TableCell className="max-w-48">
                  {b.linkUrl ? (
                    <a
                      href={b.linkUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <ExternalLink className="size-3 shrink-0" />
                      <span className="truncate">{b.linkUrl}</span>
                    </a>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Badge variant={period.variant}>{period.label}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {b.startsAt || b.endsAt
                        ? `${formatTime(b.startsAt)} ~ ${formatTime(b.endsAt)}`
                        : "不限"}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatTime(b.countdownEndsAt)}
                </TableCell>
                <TableCell>
                  <Badge variant={b.isActive ? "default" : "outline"}>
                    {b.isActive ? "启用" : "停用"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <BannerEditButton row={b} />
                    <BannerToggleActiveButton id={b.id} isActive={b.isActive} />
                    <BannerDeleteButton id={b.id} title={b.title} />
                  </div>
                </TableCell>
              </TableRow>
            )
          })
        )}
      </TableBody>
    </Table>
  )
}
