"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { FilePlus2, Library, Loader2, RefreshCw } from "lucide-react"
import Link from "next/link"
import {
  deletePublishTemplateAction,
  listPublishTemplatesAction,
  type TemuPublishTemplateRow,
} from "@/server/actions/temu-publish"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TemplateWizard } from "./template-wizard"

/**
 * TEMU 刊登模板管理（本页只做模板的创建/编辑/删除）。
 * 实际发品入口在 店铺管理 → TEMU → 商品发布（模板选择 + 店铺提交 + 发品记录）。
 */
export function TemuTemplateManager({ isAdmin }: { isAdmin: boolean }) {
  const [templates, setTemplates] = useState<TemuPublishTemplateRow[]>([])
  const [loading, setLoading] = useState(true)

  const [wizardOpen, setWizardOpen] = useState(false)
  const [editing, setEditing] = useState<TemuPublishTemplateRow | null>(null)
  const [deleting, setDeleting] = useState<TemuPublishTemplateRow | null>(null)
  const [deletePending, setDeletePending] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    const r = await listPublishTemplatesAction()
    if (r.ok) setTemplates(r.rows)
    else toast.error(r.error)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onDelete = async () => {
    if (!deleting) return
    setDeletePending(true)
    const r = await deletePublishTemplateAction(deleting.id)
    setDeletePending(false)
    if (r.ok) {
      toast.success(`已删除模板「${deleting.name}」`)
      setDeleting(null)
      void refresh()
    } else toast.error(r.error)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-2.5 rounded-lg border border-blue-500/30 bg-blue-500/5 px-3.5 py-2.5 text-sm text-blue-700 dark:text-blue-300">
        <Library className="mt-0.5 size-4 shrink-0" />
        <p>
          模板 = 锁定骨架（类目/属性/规格/产地/重量体积）+ 默认值（标题/图/申报价/货号）。
          本页维护模板；发品请到{" "}
          <Link href="/temu?tab=publish" className="font-medium underline underline-offset-2">
            店铺管理 → TEMU → 商品发布
          </Link>
          。
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">刊登模板（{templates.length}）</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void refresh()} disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              刷新
            </Button>
            {isAdmin && (
              <Button
                onClick={() => {
                  setEditing(null)
                  setWizardOpen(true)
                }}
              >
                <FilePlus2 className="size-4" />
                新建模板
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {templates.length === 0 && !loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              还没有模板。点击「新建模板」：选类目 → 填属性与规格 → 上传素材图 → 保存。
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>模板</TableHead>
                  <TableHead>类目</TableHead>
                  <TableHead>规格</TableHead>
                  <TableHead>默认申报价</TableHead>
                  <TableHead>更新时间</TableHead>
                  {isAdmin && <TableHead className="text-right">操作</TableHead>}
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
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(tpl.updatedAt).toLocaleString("zh-CN", { hour12: false })}
                    </TableCell>
                    {isAdmin && (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setEditing(tpl)
                              setWizardOpen(true)
                            }}
                          >
                            编辑
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setDeleting(tpl)}>
                            删除
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {wizardOpen && (
        <TemplateWizard
          open={wizardOpen}
          editing={editing}
          onOpenChange={(v) => {
            setWizardOpen(v)
            if (!v) {
              setEditing(null)
              void refresh()
            }
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="删除模板"
        description={`将删除模板「${deleting?.name ?? ""}」，删除后不可再用于发品（历史发品记录保留），此操作不可恢复。`}
        confirmText="删除"
        destructive
        pending={deletePending}
        onConfirm={() => void onDelete()}
      />
    </div>
  )
}
