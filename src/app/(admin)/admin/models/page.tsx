import { requireEnterpriseAdmin } from "@/lib/auth/session"
import { listModelsAction } from "@/server/actions/admin-models"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
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
} from "@/components/shared/table-pagination"
import { TableEmpty } from "@/components/shared/table-empty"
import { StatCard } from "@/components/shared/stat-card"
import { EmptyHint } from "@/components/temu/empty-hint"
import { ModelBadge } from "@/components/model-badge"
import { toImageSrc } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  ModelFormDialog,
  ModelEditButton,
  ModelToggleActiveButton,
} from "@/components/admin/model-form-dialog"

export const dynamic = "force-dynamic"

const FORMAT_LABEL: Record<string, string> = {
  openai: "OpenAI 标准生图",
  jimeng: "即梦",
  gemini: "Gemini",
  grsai: "Gemini（Grsai）",
}

export default async function AdminModelsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireEnterpriseAdmin()
  const page = parsePageParam(await searchParams)
  const {
    items: models,
    total,
    presetCount,
    privateCount,
    activeCount,
    pageSize,
  } = await listModelsAction({ page, pageSize: 20 })

  // 需求 2c：企业 allowCustomModels=false 时禁止自建/编辑私有模型
  const allowCustom = ctx.enterprise?.allowCustomModels ?? true

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        {allowCustom ? (
          <ModelFormDialog />
        ) : (
          <span className="rounded-md border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
            平台已关闭本企业自定义模型
          </span>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="平台预置">{presetCount.toLocaleString('zh-CN')}</StatCard>
        <StatCard label="企业私有">{privateCount.toLocaleString('zh-CN')}</StatCard>
        <StatCard label="启用中">{activeCount.toLocaleString('zh-CN')}</StatCard>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">模型列表</CardTitle>
          <CardDescription>
            平台生图模型（enterpriseId 为空）所有企业可见且不可修改；企业私有模型可编辑/启停
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-14">图标</TableHead>
                <TableHead>显示名</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>接口</TableHead>
                <TableHead>积分/张</TableHead>
                <TableHead>可见性</TableHead>
                <TableHead>运行参数</TableHead>
                <TableHead>勋章</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((m) => {
                const isPreset = m.enterpriseId === null
                // 自定义模型开关关闭时，私有模型也变只读
                const readOnly = isPreset || !allowCustom
                // 可见性：五域全开=全部页面可见；部分开启时 Tooltip 列出具体页
                const visPages = [
                  ["创作", m.visibleInCreate],
                  ["批量", m.visibleInWorkspace],
                  ["商品", m.visibleInProduct],
                  ["穿戴", m.visibleInWeartry],
                  ["样机", m.visibleInMockup],
                ] as const
                const visOn = visPages.filter(([, v]) => v)
                return (
                  <TableRow key={m.id}>
                    <TableCell>
                      {m.iconUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={toImageSrc(m.iconUrl)}
                          alt=""
                          className="size-8 rounded-md bg-muted/40 object-contain"
                        />
                      ) : (
                        <div className="flex size-8 items-center justify-center rounded-md bg-muted/40 text-xs font-medium text-muted-foreground">
                          {m.displayName?.slice(0, 1) ?? "?"}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-medium">
                      {m.description?.trim() ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger className="cursor-default text-left">
                              {m.displayName}
                            </TooltipTrigger>
                            <TooltipContent className="max-w-64">
                              {m.description}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        m.displayName
                      )}
                    </TableCell>
                    <TableCell>
                      {isPreset ? (
                        <Badge variant="secondary">平台预置</Badge>
                      ) : (
                        <Badge variant="outline">企业私有</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {/* 平台预置不暴露接口信息（口径：接口仅企业自建可见） */}
                      {isPreset ? (
                        <EmptyHint />
                      ) : (
                        <>
                          {FORMAT_LABEL[m.apiFormat] ?? m.apiFormat}
                          {m.supportsReferenceImage ? (
                            <span className="ml-1 text-xs text-muted-foreground">
                              · 参考图
                            </span>
                          ) : null}
                        </>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {m.costPerImage}
                    </TableCell>
                    <TableCell className="text-xs">
                      {visOn.length === 0 ? (
                        <span className="text-muted-foreground">未开放</span>
                      ) : visOn.length === visPages.length ? (
                        "全部页面可见"
                      ) : (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger className="cursor-default">
                              部分页面可见
                            </TooltipTrigger>
                            <TooltipContent>
                              {visOn.map(([label]) => label).join(" / ")}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger className="cursor-default">
                            {m.maxConcurrent} / {m.maxRetries} / {m.apiTimeout}s
                          </TooltipTrigger>
                          <TooltipContent>
                            并发 {m.maxConcurrent} · 重试 {m.maxRetries} · 接口超时{" "}
                            {m.apiTimeout}s
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </TableCell>
                    <TableCell>
                      {m.badgeText?.trim() ? (
                        <ModelBadge
                          text={m.badgeText.trim()}
                          color={m.badgeColor}
                        />
                      ) : (
                        <EmptyHint />
                      )}
                    </TableCell>
                    <TableCell>
                      {m.isActive ? (
                        <Badge>启用</Badge>
                      ) : (
                        <Badge variant="outline">停用</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {readOnly ? (
                        <span className="text-xs text-muted-foreground">
                          只读
                        </span>
                      ) : (
                        <div className="flex gap-1">
                          <ModelEditButton model={m} />
                          <ModelToggleActiveButton model={m} />
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
              {models.length === 0 ? (
                <TableEmpty colSpan={10} noun="模型" />
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/models"
        />
      </Card>
    </div>
  )
}
