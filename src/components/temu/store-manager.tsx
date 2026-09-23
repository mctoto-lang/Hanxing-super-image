"use client"

import * as React from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import {
  createTemuStoreAction,
  updateTemuStoreAction,
  resetTemuStoreTokenAction,
  toggleTemuStoreAction,
  deleteTemuStoreAction,
  clearTemuStoreDataAction,
  confirmDiscoveredStoreAction,
  reorderTemuStoresAction,
  type TemuStoreBrief,
} from "@/server/actions/temu"
import { useDragSort, DragHandle } from "@/hooks/use-drag-sort"

/**
 * Temu 店铺管理：新增（插件发现-确认-同步 / 手动创建）、编辑、拖拽排序、
 * 启停、重置 token、清空数据。
 *
 * 交互统一：确认类操作走 ConfirmDialog / Dialog（焦点管理、无障碍语义），
 * 操作结果统一 toast 反馈（替代原生 confirm 与内联红字）。
 */

/** 统一执行 + 反馈：成功/失败均走全局 toast；返回是否成功 */
async function run(message: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    toast.success(message)
    return true
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 120)
    toast.error(msg || "操作失败，请稍后重试")
    return false
  }
}

export function TemuStoreManager({
  stores,
  discovered,
}: {
  stores: TemuStoreBrief[]
  discovered: { mallId: string; mallName: string | null; firstSeenAt: Date; lastSeenAt: Date }[]
}) {
  const [tokenShown, setTokenShown] = React.useState<{ name: string; token: string } | null>(null)
  const [editing, setEditing] = React.useState<{ id: string; name: string; mallId: string; mallName: string } | null>(null)
  /** 发现店铺"确认收录"进行中（mallId） */
  const [confirming, setConfirming] = React.useState<string | null>(null)
  const [adding, setAdding] = React.useState<{ name: string; mallId: string; mallName: string } | null>(null)
  /** 危险操作二次确认（删除 / 清空数据） */
  const [confirmAction, setConfirmAction] = React.useState<
    { type: "delete" | "clear"; store: TemuStoreBrief } | null
  >(null)
  const [pending, startTransition] = React.useTransition()

  return (
    <div className="space-y-6">
      {/* 新 token 弹层（仅重置/新建时展示一次） */}
      <Dialog open={tokenShown !== null} onOpenChange={(o) => !o && setTokenShown(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>「{tokenShown?.name}」上报 Token</DialogTitle>
            <DialogDescription>
              无需手动复制：插件在浏览器登录 super-image 后会自动同步该店铺（如需手动对接，Token 仅此一次明文展示）。
            </DialogDescription>
          </DialogHeader>
          <code className="block break-all rounded-md bg-muted p-3 font-mono text-sm">
            {tokenShown?.token}
          </code>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(tokenShown?.token ?? "")
                  .then(() => toast.success("Token 已复制"))
                  .catch(() => toast.error("复制失败，请手动选择复制"))
              }}
            >
              复制
            </Button>
            <Button onClick={() => setTokenShown(null)}>我已保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 手动新增店铺：首个店铺的唯一入口（发现收录依赖已有店铺作上报通道） */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
        <div>
          <h3 className="text-sm font-semibold">店铺列表</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            首个店铺在此手动添加，生成上报 Token 后插件自动同步；
            之后的店铺由插件发现账号下的店铺列表，在下方一键收录。
          </p>
        </div>
        <Button size="sm" disabled={pending} onClick={() => setAdding({ name: "", mallId: "", mallName: "" })}>
          新增店铺
        </Button>
      </div>

      {/* 插件发现的店铺（数据内嵌 supplierId 自动登记）→ 首次确认收录 */}
      <div className="rounded-xl border p-4">
        <h3 className="text-sm font-semibold">插件发现的店铺</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          企业下登录用户使用插件采集时自动发现的 Temu 店铺。确认收录后建店并自动绑定 mallId，
          插件会在 10 分钟内同步该店铺，之后采集的数据归属到它。
        </p>
        <div className="mt-3 space-y-2">
          {discovered.length === 0 && (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              暂无待确认的新店铺：插件登录卖家中心后会实时上报账号下的店铺列表；
              若一直未出现，请确认已在插件中登录本面板账号，且下方已收录至少一个店铺作为上报通道
              （首个店铺需手动添加）。
            </p>
          )}
          {discovered.map((d) => (
            <div key={d.mallId} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{d.mallName || "未命名店铺"}</div>
                <div className="text-xs text-muted-foreground">
                  mall:{d.mallId} · 首次发现{" "}
                  {new Date(d.firstSeenAt).toLocaleString("zh-CN", { hour12: false })} · 最近上报{" "}
                  {new Date(d.lastSeenAt).toLocaleString("zh-CN", { hour12: false })}
                </div>
              </div>
              <Button
                size="sm"
                disabled={pending || confirming === d.mallId}
                onClick={() => {
                  setConfirming(d.mallId)
                  startTransition(async () => {
                    await run("店铺已收录，插件将在 10 分钟内同步", () =>
                      confirmDiscoveredStoreAction({ mallId: d.mallId }),
                    )
                    setConfirming(null)
                  })
                }}
              >
                {confirming === d.mallId ? "收录中…" : "确认收录"}
              </Button>
            </div>
          ))}
        </div>
      </div>

      {/* 编辑店铺（名称 / mallId 绑定） */}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>编辑店铺</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm text-muted-foreground">店铺名称</label>
              <Input value={editing?.name ?? ""} onChange={(e) => setEditing(editing && { ...editing, name: e.target.value })} className="mt-1" />
            </div>
            <div>
              <label className="text-sm text-muted-foreground">Temu mallId（多店巡检归属跟随的依据）</label>
              <Input
                value={editing?.mallId ?? ""}
                onChange={(e) => setEditing(editing && { ...editing, mallId: e.target.value })}
                placeholder="如 634418211196072（留空 = 未绑定）"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground">Temu 店铺名</label>
              <Input value={editing?.mallName ?? ""} onChange={(e) => setEditing(editing && { ...editing, mallName: e.target.value })} className="mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>取消</Button>
            <Button
              disabled={pending}
              onClick={() =>
                editing &&
                startTransition(async () => {
                  const ok = await run("店铺已更新", () =>
                    updateTemuStoreAction({
                      id: editing.id,
                      name: editing.name.trim() || undefined,
                      mallId: editing.mallId.trim() || null,
                      mallName: editing.mallName.trim() || null,
                    }),
                  )
                  if (ok) setEditing(null)
                })
              }
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 新增店铺：建店即生成 deviceToken（成功后一次性明文展示） */}
      <Dialog open={adding !== null} onOpenChange={(o) => !o && setAdding(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>新增店铺</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm text-muted-foreground">店铺名称（必填）</label>
              <Input
                value={adding?.name ?? ""}
                onChange={(e) => setAdding(adding && { ...adding, name: e.target.value })}
                placeholder="如 RoseBlanche 主店"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground">
                Temu mallId（可选，多店巡检归属依据，可稍后编辑绑定）
              </label>
              <Input
                value={adding?.mallId ?? ""}
                onChange={(e) => setAdding(adding && { ...adding, mallId: e.target.value })}
                placeholder="如 634418211196072（留空 = 暂不绑定）"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground">Temu 店铺名（可选）</label>
              <Input
                value={adding?.mallName ?? ""}
                onChange={(e) => setAdding(adding && { ...adding, mallName: e.target.value })}
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdding(null)}>取消</Button>
            <Button
              disabled={pending || !adding?.name.trim()}
              onClick={() =>
                adding &&
                startTransition(async () => {
                  const ok = await run("店铺已创建", async () => {
                    const created = await createTemuStoreAction({
                      name: adding.name.trim(),
                      mallId: adding.mallId.trim() || undefined,
                      mallName: adding.mallName.trim() || undefined,
                    })
                    setTokenShown({ name: created.store.name, token: created.deviceToken })
                  })
                  if (ok) setAdding(null)
                })
              }
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除 / 清空数据二次确认（替代原生 confirm） */}
      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(o) => !o && setConfirmAction(null)}
        title={confirmAction?.type === "delete" ? "删除店铺" : "清空采集数据"}
        description={
          confirmAction?.type === "delete"
            ? `将删除店铺「${confirmAction.store.name}」及其全部采集数据，此操作不可恢复。`
            : `将清空店铺「${confirmAction?.store.name}」的全部采集数据，店铺本身与 token 保留。\n（用于重新采集测试：插件去重缓存约 30 秒自动重置，清空后稍候再采集即可全量入库）`
        }
        confirmText={confirmAction?.type === "delete" ? "删除" : "清空"}
        destructive
        pending={pending}
        onConfirm={() => {
          const action = confirmAction
          if (!action) return
          startTransition(async () => {
            const ok =
              action.type === "delete"
                ? await run(`已删除店铺「${action.store.name}」`, () =>
                    deleteTemuStoreAction({ id: action.store.id }),
                  )
                : await run(`已清空「${action.store.name}」采集数据`, () =>
                    clearTemuStoreDataAction({ id: action.store.id }),
                  )
            if (ok) setConfirmAction(null)
          })
        }}
      />

      <div className="space-y-3">
        <StoreList
          stores={stores}
          pending={pending}
          onEdit={(s) => setEditing({ id: s.id, name: s.name, mallId: s.mallId || "", mallName: s.mallName || "" })}
          onResetToken={(s) =>
            startTransition(() =>
              void (async () => {
                try {
                  const r = await resetTemuStoreTokenAction({ id: s.id })
                  setTokenShown({ name: s.name, token: r.deviceToken })
                } catch (e) {
                  toast.error((e instanceof Error ? e.message : String(e)).slice(0, 120) || "重置失败")
                }
              })(),
            )
          }
          onToggle={(s) =>
            startTransition(() =>
              void run(s.enabled ? `已停用「${s.name}」` : `已启用「${s.name}」`, () =>
                toggleTemuStoreAction({ id: s.id, enabled: !s.enabled }),
              ),
            )
          }
          onDelete={(s) => setConfirmAction({ type: "delete", store: s })}
          onClearData={(s) => setConfirmAction({ type: "clear", store: s })}
        />
        {stores.length === 0 && (
          <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            还没有店铺。在上方「插件发现的店铺」中确认收录，或等插件上报后自动出现。
          </p>
        )}
      </div>
    </div>
  )
}

/** 已收录店铺列表：行首手柄拖拽排序（useDragSort，drop 后保存新顺序） */
function StoreList({
  stores,
  pending,
  onEdit,
  onResetToken,
  onToggle,
  onDelete,
  onClearData,
}: {
  stores: TemuStoreBrief[]
  pending: boolean
  onEdit: (s: TemuStoreBrief) => void
  onResetToken: (s: TemuStoreBrief) => void
  onToggle: (s: TemuStoreBrief) => void
  onDelete: (s: TemuStoreBrief) => void
  onClearData: (s: TemuStoreBrief) => void
}) {
  const { ordered, rowProps, handleProps } = useDragSort({
    items: stores,
    commit: (ids) => reorderTemuStoresAction({ ids }).then((r) => ({ ok: !!r.ok })),
  })
  return (
    <>
      {ordered.map((s) => (
        <div
          key={s.id}
          {...rowProps(s.id, "flex flex-wrap items-center gap-3 rounded-xl border p-4")}
        >
          <DragHandle handleProps={handleProps(s.id)} />
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              {s.name}
              {s.mallName && <span className="ml-2 text-sm text-muted-foreground">（{s.mallName}）</span>}
            </div>
            <div className="text-xs text-muted-foreground">
              {s.mallId ? `mall:${s.mallId} · ` : "未绑定 mallId · "}
              {s.enabled ? "启用" : "已停用"} · 最近上报{" "}
              {s.lastSeenAt
                ? new Date(s.lastSeenAt).toLocaleString("zh-CN", { hour12: false })
                : "从未"}
            </div>
          </div>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => onEdit(s)}>
            编辑
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => onResetToken(s)}
          >
            重置 Token
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => onToggle(s)}
          >
            {s.enabled ? "停用" : "启用"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => onClearData(s)}
          >
            清空数据
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() => onDelete(s)}
          >
            删除
          </Button>
        </div>
      ))}
    </>
  )
}
