"use client"

import * as React from "react"
import { toast } from "sonner"
import { ArrowDown, ArrowUp, Ban, ChevronDown, ChevronUp, TriangleAlert } from "lucide-react"
import { DashRing } from "@/components/ui/dash-ring"
import { Button } from "@/components/ui/button"
import {
  updateLogisticsConfigAction,
  type TemuLogisticsPrefItem,
} from "@/server/actions/temu-ship"

/**
 * 企业级物流偏好编辑区（自动发货弹窗用）：优先顺序 + 黑名单，折叠展示。
 * 名单与「未保存修改」由父层持有（比价公司可从外部一键「加入优先」）；
 * 保存写库（temu_logistics_config，迁移 0093），成功后回传服务端归一结果。
 */
export function LogisticsPrefEditor({
  priority,
  blacklist,
  dirty,
  failed = false,
  onChange,
  onDirtyChange,
  onSaved,
  registerSave,
  defaultOpen = false,
}: {
  priority: TemuLogisticsPrefItem[]
  blacklist: TemuLogisticsPrefItem[]
  dirty: boolean
  /** 配置加载失败：名单为空不可信，禁用保存防止整体覆盖企业已有配置 */
  failed?: boolean
  onChange: (next: { priority: TemuLogisticsPrefItem[]; blacklist: TemuLogisticsPrefItem[] }) => void
  onDirtyChange: (dirty: boolean) => void
  onSaved: (next: { priority: TemuLogisticsPrefItem[]; blacklist: TemuLogisticsPrefItem[] }) => void
  /** 向父层登记保存函数（分组阻断框内的「保存偏好」按钮调用） */
  registerSave?: (save: (() => void) | null) => void
  defaultOpen?: boolean
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  const [saving, startSaving] = React.useTransition()

  const save = React.useCallback(() => {
    startSaving(async () => {
      const r = await updateLogisticsConfigAction({ priority, blacklist })
      if (r.ok) {
        onDirtyChange(false)
        onSaved({ priority: r.priority, blacklist: r.blacklist })
        toast.success("物流偏好已保存（企业级，全部设备生效）")
      } else toast.error(r.error)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priority, blacklist])

  React.useEffect(() => {
    registerSave?.(save)
    return () => registerSave?.(null)
  }, [save, registerSave])

  /** 改动名单并标脏 */
  const patch = (next: { priority: TemuLogisticsPrefItem[]; blacklist: TemuLogisticsPrefItem[] }) => {
    onChange(next)
    onDirtyChange(true)
  }
  const setPriority = (fn: (s: TemuLogisticsPrefItem[]) => TemuLogisticsPrefItem[]) =>
    patch({ priority: fn(priority), blacklist })
  const setBlacklist = (fn: (s: TemuLogisticsPrefItem[]) => TemuLogisticsPrefItem[]) =>
    patch({ priority, blacklist: fn(blacklist) })

  return (
    <section className="rounded-md border">
      <div className="flex items-center">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span>
            物流偏好（优先 {priority.length} · 黑名单 {blacklist.length}）
            {dirty && <span className="ml-1 text-amber-600 dark:text-amber-400">有未保存修改</span>}
          </span>
          {open ? <ChevronUp className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
        </button>
        {/* 折叠且有未保存修改时常驻保存入口：从分组阻断框「加入优先」后选司即时生效、
            阻断框（含其保存按钮）随即消失，否则偏好停在未保存状态、下次仍被同样阻断 */}
        {dirty && !open && (
          <Button
            size="sm"
            className="mr-2 h-6 shrink-0 px-2 text-[10px]"
            disabled={saving || failed}
            onClick={save}
          >
            {saving ? <DashRing className="size-3" /> : null} 保存偏好
          </Button>
        )}
      </div>
      {open && (
        <div className="space-y-3 border-t px-3 py-2.5 text-xs">
          {failed && (
            <p className="flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-400">
              <TriangleAlert className="size-3.5 shrink-0" />
              物流偏好配置加载失败，此处名单可能不完整——请关闭弹窗后重新打开再编辑保存，避免覆盖企业已有配置。
            </p>
          )}
          <div className="space-y-1">
            <p className="text-muted-foreground">优先顺序（自动选择按此顺序取第一个可用公司）</p>
            {priority.length === 0 && (
              <p className="text-[11px] text-muted-foreground">暂无——比价出现公司时可点「加入优先」</p>
            )}
            {priority.map((p, i) => (
              <div key={p.expressCompanyId} className="flex items-center gap-1.5">
                <span className="w-5 text-center text-muted-foreground tabular-nums">{i + 1}</span>
                <span className="flex-1">{p.expressCompanyName}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-6 p-0"
                  disabled={i === 0}
                  onClick={() =>
                    setPriority((s) => {
                      const n = [...s]
                      ;[n[i - 1], n[i]] = [n[i]!, n[i - 1]!]
                      return n
                    })
                  }
                >
                  <ArrowUp className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-6 p-0"
                  disabled={i === priority.length - 1}
                  onClick={() =>
                    setPriority((s) => {
                      const n = [...s]
                      ;[n[i + 1], n[i]] = [n[i]!, n[i + 1]!]
                      return n
                    })
                  }
                >
                  <ArrowDown className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={() => {
                    const rest = priority.filter((x) => x.expressCompanyId !== p.expressCompanyId)
                    patch({
                      priority: rest,
                      blacklist: [...blacklist.filter((x) => x.expressCompanyId !== p.expressCompanyId), p],
                    })
                  }}
                >
                  拉黑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={() =>
                    setPriority((s) => s.filter((x) => x.expressCompanyId !== p.expressCompanyId))
                  }
                >
                  移除
                </Button>
              </div>
            ))}
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground">黑名单（比价结果中剔除，不自动选择）</p>
            {blacklist.length === 0 && <p className="text-[11px] text-muted-foreground">暂无</p>}
            {blacklist.map((p) => (
              <div key={p.expressCompanyId} className="flex items-center gap-1.5">
                <Ban className="size-3 text-red-600 dark:text-red-400" />
                <span className="flex-1">{p.expressCompanyName}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={() => {
                    const rest = blacklist.filter((x) => x.expressCompanyId !== p.expressCompanyId)
                    patch({
                      blacklist: rest,
                      priority: [...priority.filter((x) => x.expressCompanyId !== p.expressCompanyId), p],
                    })
                  }}
                >
                  恢复优先
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={() =>
                    setBlacklist((s) => s.filter((x) => x.expressCompanyId !== p.expressCompanyId))
                  }
                >
                  移除
                </Button>
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <Button size="sm" className="h-7 text-xs" disabled={saving || !dirty || failed} onClick={save}>
              {saving ? <DashRing className="size-3.5" /> : null} 保存偏好（企业级）
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
