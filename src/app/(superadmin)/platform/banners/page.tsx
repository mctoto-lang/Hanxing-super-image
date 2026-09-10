import { requireSuperAdmin } from "@/lib/auth/session"
import { listBannersAction } from "@/server/actions/platform-banners"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Search } from "lucide-react"
import {
  TablePagination,
  parsePageParam,
  parseQueryParam,
} from "@/components/shared/table-pagination"
import { BannerCreateDialog } from "@/components/superadmin/banner-form-dialog"
import { BannersTable } from "@/components/superadmin/banners-table"

export const dynamic = "force-dynamic"

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
            多条启用的横幅在投放窗口内随机轮换；倒计时到期后自动下线；顺序拖动行首手柄调整
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BannersTable
            items={items}
            emptyHint={q ? `未找到与「${q}」匹配的横幅` : "暂无横幅，点击右上角新建"}
          />
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
