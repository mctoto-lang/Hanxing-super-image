"use client"

import * as React from "react"
import { toast } from "sonner"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
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
  setTemuStoreTokenAction,
  syncTemuStoreAction,
  toggleTemuStoreSyncAction,
  toggleTemuStoreAction,
  deleteTemuStoreAction,
  clearTemuStoreDataAction,
  reorderTemuStoresAction,
  type TemuStoreBrief,
} from "@/server/actions/temu"
import { useDragSort, DragHandle } from "@/hooks/use-drag-sort"
import { formatDateTime } from "@/lib/datetime"

/**
 * Temu 店铺管理（官方 API 口径）：新增、access_token 录入（保存即验证）、
 * 手动同步、定时同步开关、编辑、拖拽排序、启停、清空数据、删除。
 *
 * 交互统一：确认类操作走 ConfirmDialog / Dialog，操作结果统一 toast 反馈。
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

/** token 状态点 + 文案 */
function TokenStateBadge({ state }: { state: string }) {
  if (state === "active") {
    return <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">● token 有效</span>
  }
  if (state === "invalid") {
    return <span className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400">● token 已失效，请重录</span>
  }
  return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">○ 未录入 token</span>
}

/** 距到期天数提示（≤30 天黄色预警） */
function expiryHint(expiresAt: Date | string | null): string | null {
  if (!expiresAt) return null
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400_000)
  if (days <= 0) return "token 已到期"
  if (days <= 30) return `约 ${days} 天后到期，请提前重录`
  return null
}

export function TemuStoreManager({ stores }: { stores: TemuStoreBrief[] }) {
  const [editing, setEditing] = React.useState<{ id: string; name: string; mallId: string; mallName: string } | null>(null)
  const [adding, setAdding] = React.useState<{ name: string; mallId: string; mallName: string } | null>(null)
  /** token 录入弹层（invalid/none 状态或手动点开） */
  const [tokenInput, setTokenInput] = React.useState<{ store: TemuStoreBrief; value: string } | null>(null)
  /** 手动同步进行中（storeId） */
  const [syncing, setSyncing] = React.useState<string | null>(null)
  /** 危险操作二次确认（删除 / 清空数据） */
  const [confirmAction, setConfirmAction] = React.useState<
    { type: "delete" | "clear"; store: TemuStoreBrief } | null
  >(null)
  const [pending, startTransition] = React.useTransition()

  /** 手动同步：四源结果摘要 toast（失败源列名 + 首个错误） */
  const doSync = (store: TemuStoreBrief) => {
    setSyncing(store.id)
    void (async () => {
      try {
        const r = await syncTemuStoreAction({ id: store.id })
        if (r.skipped) {
          toast.warning(`「${store.name}」未同步：${r.skipped}`)
          return
        }
        if (r.status && r.status.ok) {
          const parts = Object.entries(r.status.sources)
            .map(([k, v]) => `${k.replace("api-", "")} ${v.count ?? 0}`)
            .join(" · ")
          toast.success(`「${store.name}」同步完成：${parts || "无数据"}`)
        } else {
          const firstErr = r.status
            ? Object.entries(r.status.sources).find(([, v]) => !v.ok)
            : undefined
          toast.error(
            `「${store.name}」部分同步失败${firstErr ? `：${firstErr[0].replace("api-", "")} — ${String(firstErr[1].error ?? "").slice(0, 90)}` : ""}`,
            { duration: 6000 },
          )
        }
      } catch (e) {
        toast.error((e instanceof Error ? e.message : String(e)).slice(0, 150) || "同步失败")
      } finally {
        setSyncing(null)
      }
    })()
  }

  return (
    <div className="space-y-6">
      {/* 概览说明 + 新增 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
        <div>
          <h3 className="text-sm font-semibold">店铺列表</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            数据经 TEMU 官方开放平台 API 定时同步（默认每 15 分钟）。添加店铺后录入卖家中心
            「授权管理」复制的 access_token，保存时自动验证店铺类型；全托/半托均可。
          </p>
        </div>
        <Button size="sm" className="h-8 text-xs" disabled={pending} onClick={() => setAdding({ name: "", mallId: "", mallName: "" })}>
          新增店铺
        </Button>
      </div>

      {/* 编辑店铺（名称 / mallId 绑定） */}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>编辑店铺</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">店铺名称</Label>
              <Input value={editing?.name ?? ""} onChange={(e) => setEditing(editing && { ...editing, name: e.target.value })} className="h-8 text-xs" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Temu mallId（可选，授权验证时自动回填）</Label>
              <Input
                value={editing?.mallId ?? ""}
                onChange={(e) => setEditing(editing && { ...editing, mallId: e.target.value })}
                placeholder="授权验证自动回填的 base64 串（留空 = 未绑定）"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Temu 店铺名</Label>
              <Input value={editing?.mallName ?? ""} onChange={(e) => setEditing(editing && { ...editing, mallName: e.target.value })} className="h-8 text-xs" />
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

      {/* 新增店铺 */}
      <Dialog open={adding !== null} onOpenChange={(o) => !o && setAdding(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>新增店铺</DialogTitle>
            <DialogDescription>
              创建后请在列表中录入 access_token（TEMU 卖家中心 → 授权管理 → 选择自研应用 →
              勾选接口 → 确认 → 复制 token）。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">店铺名称（必填）</Label>
              <Input
                value={adding?.name ?? ""}
                onChange={(e) => setAdding(adding && { ...adding, name: e.target.value })}
                placeholder="如 RoseBlanche 主店"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Temu mallId（可选，可稍后编辑或自动回填）</Label>
              <Input
                value={adding?.mallId ?? ""}
                onChange={(e) => setAdding(adding && { ...adding, mallId: e.target.value })}
                placeholder="授权验证自动回填的 base64 串（留空 = 暂不绑定）"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Temu 店铺名（可选）</Label>
              <Input
                value={adding?.mallName ?? ""}
                onChange={(e) => setAdding(adding && { ...adding, mallName: e.target.value })}
                className="h-8 text-xs"
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
                  const ok = await run("店铺已创建，接下来请录入 access_token", () =>
                    createTemuStoreAction({
                      name: adding.name.trim(),
                      mallId: adding.mallId.trim() || undefined,
                      mallName: adding.mallName.trim() || undefined,
                    }),
                  )
                  if (ok) setAdding(null)
                })
              }
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* access_token 录入（保存即验证） */}
      <Dialog open={tokenInput !== null} onOpenChange={(o) => !o && setTokenInput(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>录入 access_token · {tokenInput?.store.name}</DialogTitle>
            <DialogDescription>
              TEMU 卖家中心 → 授权管理 → 选择自研应用 → 勾选接口（建议全选）→ 确认 → 复制
              token 粘贴到此。自研应用 token 有效期 365 天，过期需重新授权复制。保存时自动调用
              官方接口验证并识别全托/半托。
            </DialogDescription>
          </DialogHeader>
          <Input
            value={tokenInput?.value ?? ""}
            onChange={(e) => setTokenInput(tokenInput && { ...tokenInput, value: e.target.value })}
            placeholder="粘贴 access_token"
            className="h-8 font-mono text-xs"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setTokenInput(null)}>取消</Button>
            <Button
              disabled={pending || !tokenInput?.value.trim()}
              onClick={() =>
                tokenInput &&
                startTransition(async () => {
                  try {
                    const r = await setTemuStoreTokenAction({
                      id: tokenInput.store.id,
                      accessToken: tokenInput.value.trim(),
                    })
                    if (r.ok) {
                      const typeText = r.mallType === "semi" ? "半托店铺" : "全托店铺"
                      toast.success(`token 验证通过：${typeText}${r.mallId ? `（mall:${r.mallId}）` : ""}`)
                      setTokenInput(null)
                    } else {
                      toast.error(r.error ?? "token 验证失败", { duration: 6000 })
                    }
                  } catch (e) {
                    toast.error((e instanceof Error ? e.message : String(e)).slice(0, 150) || "保存失败")
                  }
                })
              }
            >
              保存并验证
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除 / 清空数据二次确认 */}
      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(o) => !o && setConfirmAction(null)}
        title={confirmAction?.type === "delete" ? "删除店铺" : "清空同步数据"}
        description={
          confirmAction?.type === "delete"
            ? `将删除店铺「${confirmAction.store.name}」及其全部数据，此操作不可恢复。`
            : `将清空店铺「${confirmAction?.store.name}」的全部数据，店铺与 token 保留。下次同步（定时或手动）会全量重建。`
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
                : await run(`已清空「${action.store.name}」数据`, () =>
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
          syncing={syncing}
          onEdit={(s) => setEditing({ id: s.id, name: s.name, mallId: s.mallId || "", mallName: s.mallName || "" })}
          onToken={(s) => setTokenInput({ store: s, value: "" })}
          onSync={doSync}
          onToggleSync={(s, syncEnabled) =>
            startTransition(() =>
              void run(
                syncEnabled ? `已开启「${s.name}」定时同步` : `已暂停「${s.name}」定时同步`,
                () => toggleTemuStoreSyncAction({ id: s.id, syncEnabled }),
              ),
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
            还没有店铺。点击上方「新增店铺」创建，然后录入 TEMU 卖家中心复制的 access_token。
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
  syncing,
  onEdit,
  onToken,
  onSync,
  onToggleSync,
  onToggle,
  onDelete,
  onClearData,
}: {
  stores: TemuStoreBrief[]
  pending: boolean
  syncing: string | null
  onEdit: (s: TemuStoreBrief) => void
  onToken: (s: TemuStoreBrief) => void
  onSync: (s: TemuStoreBrief) => void
  onToggleSync: (s: TemuStoreBrief, syncEnabled: boolean) => void
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
      {ordered.map((s) => {
        const expiry = expiryHint(s.tokenExpiresAt)
        return (
          <div
            key={s.id}
            {...rowProps(s.id, "flex flex-wrap items-center gap-3 rounded-xl border p-4")}
          >
            <DragHandle handleProps={handleProps(s.id)} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 font-medium">
                {s.name}
                {s.mallName && <span className="text-sm text-muted-foreground">（{s.mallName}）</span>}
                {s.mallType && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {s.mallType === "semi" ? "半托" : "全托"}
                  </span>
                )}
                <TokenStateBadge state={s.tokenState} />
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {s.mallId ? `mall:${s.mallId} · ` : "未绑定 mallId · "}
                {s.enabled ? "启用" : "已停用"} · 最近同步{" "}
                {s.lastSyncAt ? formatDateTime(s.lastSyncAt) : "从未"}
                {expiry && <span className="ml-2 text-amber-600 dark:text-amber-400">{expiry}</span>}
              </div>
            </div>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              定时同步
              <Switch
                checked={s.syncEnabled}
                disabled={pending}
                onCheckedChange={(v) => onToggleSync(s, v)}
              />
            </label>
            <Button
              size="sm"
              variant={s.tokenState === "active" ? "outline" : "default"}
              disabled={pending}
              onClick={() => onToken(s)}
            >
              {s.tokenState === "none" ? "录入 Token" : "重录 Token"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || syncing === s.id}
              onClick={() => onSync(s)}
            >
              <RefreshCw className={syncing === s.id ? "mr-1 size-3.5 animate-spin" : "mr-1 size-3.5"} />
              {syncing === s.id ? "同步中…" : "立即同步"}
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => onEdit(s)}>
              编辑
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
        )
      })}
    </>
  )
}
