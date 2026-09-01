import { requireSuperAdmin } from "@/lib/auth/session"
import { listBannersAction } from "@/server/actions/platform-banners"
import { BANNER_ICON_OPTIONS } from "@/lib/banner"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ExternalLink, Search } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  TablePagination,
  parsePageParam,
  parseQueryParam,
} from "@/components/shared/table-pagination"
import {
  BannerCreateDialog,
  BannerEditButton,
  BannerToggleActiveButton,
} from "@/components/superadmin/banner-form-dialog"
import { BannerDeleteButton } from "@/components/superadmin/banner-delete-dialog"

export const dynamic = "force-dynamic"

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

export default async function PlatformBannersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireSuperAdmin()
  const sp = await searchParams
  const page = parsePageParam(sp)
  const q = parseQueryParam(sp, "q")

  const { items, total, pageSize } = await listBannersAction({
    page,
    pageSize: 20,
    q,
  })

  const iconLabel = (icon: string) =>
    BANNER_ICON_OPTIONS.find((o) => o.value === icon)?.label ?? icon

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">广告横幅</h1>
          <p className="text-sm text-muted-foreground">
            配置登录后全站轮换展示的宣传横幅（内容、倒计时、站外跳转、投放周期）·
            共 {total} 条
          </p>
        </div>
        <div className="flex items-center gap-2">
          <form action="/platform/banners" className="flex items-center gap-2">
            <Input
              name="q"
              defaultValue={q}
              placeholder="搜索标题 / 内容"
              className="w-56"
            />
            <Button type="submit" variant="outline" size="sm">
              <Search className="size-3.5" />
              搜索
            </Button>
          </form>
          <BannerCreateDialog />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">横幅列表</CardTitle>
          <CardDescription>
            多条启用的横幅在投放窗口内随机轮换；倒计时到期后自动下线
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>标题 / 内容</TableHead>
                <TableHead>跳转链接</TableHead>
                <TableHead>投放周期</TableHead>
                <TableHead>倒计时截止</TableHead>
                <TableHead>排序</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-8 text-center text-muted-foreground"
                  >
                    {q ? `未找到与「${q}」匹配的横幅` : "暂无横幅，点击右上角新建"}
                  </TableCell>
                </TableRow>
              ) : (
                items.map((b) => {
                  const period = periodBadge(b.startsAt, b.endsAt)
                  return (
                    <TableRow key={b.id}>
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
                      <TableCell className="text-sm tabular-nums">
                        {b.sortOrder}
                      </TableCell>
                      <TableCell>
                        <Badge variant={b.isActive ? "default" : "outline"}>
                          {b.isActive ? "启用" : "停用"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <BannerEditButton row={b} />
                          <BannerToggleActiveButton
                            id={b.id}
                            isActive={b.isActive}
                          />
                          <BannerDeleteButton id={b.id} title={b.title} />
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/platform/banners"
          query={{ q }}
        />
      </Card>
    </div>
  )
}
