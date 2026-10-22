"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import Link from "next/link"
import { FilePlus2, Loader2, RefreshCw, Send } from "lucide-react"
import type { TemuStoreBrief } from "@/server/actions/temu"
import {
  listPublishRecordsAction,
  listPublishTemplatesAction,
  type TemuPublishRecordRow,
  type TemuPublishTemplateRow,
} from "@/server/actions/temu-publish"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { PublishDialog } from "./publish-dialog"
import { PublishRecordsTable } from "./records-table"

/**
 * TEMU 商品发布面板（店铺管理 → TEMU → 商品发布）：
 * 下拉切换「商品发布 / 发品记录」——发布=选可发模板+提交 goods.add；
 * 目标店铺由页面右上角下拉切换（URL ?store= 驱动，不再在弹窗内选店）；
 * 记录=成败审计（官方错误原因 Tooltip 全文）。模板创建/编辑在 模板管理 → TEMU刊登模板。
 * 权限：本面板仅在 publish tab 可见时渲染（页面层 canAccess("temu_publish")），
 * 发品按钮对全部可见者开放（2026-10-22 口径，写侧 action 同校验）。
 */
export function TemuPublishPanel({
  store,
}: {
  /** 当前选中可发布店（全托+token 有效）；undefined=无可发布店 */
  store?: TemuStoreBrief
}) {
  const [view, setView] = useState<"publish" | "records">("publish")
  const [templates, setTemplates] = useState<TemuPublishTemplateRow[]>([])
  const [records, setRecords] = useState<TemuPublishRecordRow[]>([])
  const [loading, setLoading] = useState(false)
  const [publishing, setPublishing] = useState<TemuPublishTemplateRow | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [tpl, rec] = await Promise.all([
        listPublishTemplatesAction(),
        listPublishRecordsAction({ limit: 50 }),
      ])
      if (tpl.ok) setTemplates(tpl.rows)
      else toast.error(tpl.error)
      if (rec.ok) setRecords(rec.rows)
    } catch {
      // server action promise reject（请求超限 / 网络错）时兜底提示；finally 复位
      // loading，避免刷新按钮永久转圈
      toast.error("刷新失败：请求过大或网络错误，请重试")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const canPublish = store != null

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">

      {view === "publish" ? (
        <Card className="flex min-h-0 flex-1 flex-col">
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base">刊登模板（{templates.length}）</CardTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-9! text-xs"
                nativeButton={false}
                render={<Link href="/templates/temu" />}
              >
                <FilePlus2 className="size-4" />
                管理模板
              </Button>
              <ViewSwitch value={view} onChange={setView} />
              <Button variant="outline" size="sm" className="h-9! text-xs" onClick={() => void refresh()} disabled={loading}>
                {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                刷新
              </Button>
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
            {templates.length === 0 && !loading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                还没有模板。先到
                <Link href="/templates/temu" className="mx-1 underline underline-offset-2">
                  模板管理 → TEMU刊登模板
                </Link>
                创建模板。
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>模板</TableHead>
                    <TableHead>类目</TableHead>
                    <TableHead>规格</TableHead>
                    <TableHead>默认申报价</TableHead>
                    <TableHead>素材图</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {templates.map((tpl) => (
                    <TableRow key={tpl.id}>
                      <TableCell>
                        <div className="font-medium">{tpl.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {tpl.defaults.title.slice(0, 24)}（{tpl.attributeCount} 属性）
                        </div>
                      </TableCell>
                      <TableCell className="max-w-64 truncate text-xs text-muted-foreground">
                        {tpl.categoryChain.map((c) => c.catName).join(" / ")}
                      </TableCell>
                      <TableCell className="text-xs">
                        {tpl.specConfig.parentSpecName}：{tpl.specConfig.specName}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        ¥{(tpl.defaults.declaredPriceFen / 100).toFixed(2)}
                      </TableCell>
                      <TableCell>{tpl.defaults.imageUrls.length} 张</TableCell>
                      <TableCell className="text-right">
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={!canPublish}
                                onClick={() => setPublishing(tpl)}
                              >
                                <Send className="size-4" />
                                发品
                              </Button>
                            }
                          />
                          <TooltipContent>
                            {store == null
                              ? "无启用且 token 有效的全托店铺"
                              : "提交发品到当前选中店铺（标题/图/价可覆盖）"}
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card className="flex min-h-0 flex-1 flex-col">
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base">发品记录</CardTitle>
            <div className="flex items-center gap-2">
              <ViewSwitch value={view} onChange={setView} />
              <Button variant="outline" size="sm" className="h-9! text-xs" onClick={() => void refresh()} disabled={loading}>
                {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                刷新
              </Button>
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
            <PublishRecordsTable rows={records} />
          </CardContent>
        </Card>
      )}

      {publishing && store && (
        <PublishDialog
          template={publishing}
          store={store}
          onOpenChange={(v) => {
            if (!v) {
              setPublishing(null)
              void refresh()
            }
          }}
        />
      )}
    </div>
  )
}

/** 视图切换：商品发布 / 发品记录（Select 传 items+children 显示中文） */
function ViewSwitch({
  value,
  onChange,
}: {
  value: "publish" | "records"
  onChange: (v: "publish" | "records") => void
}) {
  return (
    <Select
      items={[
        { value: "publish", label: "商品发布" },
        { value: "records", label: "发品记录" },
      ]}
      value={value}
      onValueChange={(v) => v && onChange(v as "publish" | "records")}
    >
      <SelectTrigger className="h-9! w-32 text-xs" aria-label="切换视图">
        <SelectValue>{value === "publish" ? "商品发布" : "发品记录"}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="publish">商品发布</SelectItem>
        <SelectItem value="records">发品记录</SelectItem>
      </SelectContent>
    </Select>
  )
}
