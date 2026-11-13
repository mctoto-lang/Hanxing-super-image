"use client"

import * as React from "react"
import { toast } from "sonner"
import { ChevronDown, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
  type TemuAppBrief,
} from "@/server/actions/temu"
import { MAX_STORES_PER_APP } from "@/lib/temu-api/constants"
import { useDragSort, DragHandle } from "@/hooks/use-drag-sort"
import { formatDateTime } from "@/lib/datetime"
import { cn } from "@/lib/utils"

/**
 * Temu 店铺管理（设置页式表单，多主体模型）：
 *
 * - 按应用（主体）分组，每组 header 展示应用名/测试模式徽章/店铺数 n/20；
 *   组内每店一块可折叠表单卡（名称/mallId/Temu 店铺名直接编辑保存，
 *   token 录入走弹窗、保存即验证），组内拖拽排序。
 * - 「新增店铺」一步到位：选应用 + 名称 + mallId + 可选 token（填了即验证）。
 * - 演示模式（企业未配置 TEMU 应用）：演示店铺只读展示（可手动同步），
 *   新增真实店铺入口引导先配置应用。
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

interface AddingForm {
  appId: string
  name: string
  mallId: string
  mallName: string
  accessToken: string
}

export function TemuStoreManager({
  stores,
  apps,
  demoMode,
}: {
  stores: TemuStoreBrief[]
  apps: TemuAppBrief[]
  demoMode: boolean
}) {
  const realStores = stores.filter((s) => !s.isDemo)
  const demoStores = stores.filter((s) => s.isDemo)
  const [adding, setAdding] = React.useState<AddingForm | null>(null)
  const [pending] = React.useTransition()
  /** 新增弹窗：token 提交后走验证（不中断弹窗，验证失败留在弹窗提示） */
  const [submitting, setSubmitting] = React.useState(false)

  const appSelectable = apps.filter((a) => a.storeCount < MAX_STORES_PER_APP)

  /** 组内拖拽 commit：替换该组段后按应用顺序拍平成全量序列提交 */
  const commitGroupOrder = (appId: string | null, newIds: string[]) => {
    const segOf = (id: string | null) =>
      id === appId
        ? newIds
        : realStores.filter((s) => s.appId === id).map((s) => s.id)
    const flat = [...apps.map((a) => a.id), null].flatMap(segOf)
    return reorderTemuStoresAction({ ids: flat }).then((r) => ({
      ok: !!r.ok,
      error: r.ok ? null : "排序保存失败",
    }))
  }

  const doSync = (store: { id: string; name: string }) => {
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
      }
    })()
  }

  const submitAdding = () => {
    if (!adding) return
    setSubmitting(true)
    void (async () => {
      try {
        const created = await createTemuStoreAction({
          appId: adding.appId,
          name: adding.name.trim(),
          mallId: adding.mallId.trim() || undefined,
          mallName: adding.mallName.trim() || undefined,
        })
        if (!created.ok || !created.store) {
          toast.error(created.error ?? "创建失败")
          return
        }
        if (adding.accessToken.trim()) {
          const tokenRes = await setTemuStoreTokenAction({
            id: created.store.id,
            accessToken: adding.accessToken.trim(),
          })
          if (!tokenRes.ok) {
            toast.error(`店铺已创建，但 token 验证失败：${tokenRes.error ?? "未知错误"}`, { duration: 6000 })
            setAdding(null)
            return
          }
          toast.success(`token 验证通过：${tokenRes.mallType === "semi" ? "半托店铺" : "全托店铺"}`)
        } else {
          toast.success("店铺已创建，请在卡片中录入 access_token")
        }
        setAdding(null)
      } catch (e) {
        toast.error((e instanceof Error ? e.message : String(e)).slice(0, 150) || "创建失败")
      } finally {
        setSubmitting(false)
      }
    })()
  }

  return (
    <div className="space-y-4">
      {/* 概览说明 + 新增 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
        <div>
          <h3 className="text-sm font-semibold">店铺管理</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            按应用（主体）分组管理店铺：单应用最多 {MAX_STORES_PER_APP} 家。添加店铺后录入卖家中心
            「授权管理」复制的 access_token，保存时自动验证店铺类型；全托/半托均可。
          </p>
        </div>
        <Button
          size="sm"
          className="h-8 text-xs"
          disabled={pending || apps.length === 0 || appSelectable.length === 0}
          onClick={() =>
            setAdding({ appId: appSelectable[0]?.id ?? "", name: "", mallId: "", mallName: "", accessToken: "" })
          }
        >
          新增店铺
        </Button>
      </div>

      {/* 演示模式（企业未配置 TEMU 应用） */}
      {demoMode && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-400">
            演示模式 · 未配置 TEMU 应用
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            当前展示的店铺与数据为内置虚拟演示数据（100 款商品、售价 100+ 元、单日销量
            100+），仅供体验各页面功能。请联系平台管理员在「超管 → 企业管理 → TEMU应用」
            配置自研应用，配置后将自动切换为正式店铺与数据。
          </p>
          {demoStores.map((s) => (
            <DemoStoreCard key={s.id} store={s} />
          ))}
        </div>
      )}

      {/* 应用分组 */}
      <div className="space-y-4">
        {apps.map((app) => (
          <AppGroup
            key={app.id}
            app={app}
            stores={realStores.filter((s) => s.appId === app.id)}
            pending={pending}
            onGroupReorder={commitGroupOrder}
            onSync={doSync}
          />
        ))}
        {/* 未归属店铺（迁移兜底：正常企业不应出现；仅展示与既有操作） */}
        {(() => {
          const orphan = realStores.filter((s) => !s.appId)
          if (orphan.length === 0) return null
          return (
            <AppGroup
              app={{ id: "", name: "未归属应用", testMode: false, storeCount: orphan.length }}
              stores={orphan}
              pending={pending}
              onGroupReorder={commitGroupOrder}
              onSync={doSync}
            />
          )
        })()}
        {apps.length === 0 && !demoMode && (
          <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            尚未配置 TEMU 应用。请联系平台管理员在「超管 → 企业管理 → TEMU应用」添加应用后，再在此创建店铺。
          </p>
        )}
      </div>

      {/* 新增店铺（一步到位：应用 + 名称 + mallId + 可选 token） */}
      <Dialog open={adding !== null} onOpenChange={(o) => !o && setAdding(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>新增店铺</DialogTitle>
            <DialogDescription>
              选择所属应用（主体）后填写店铺信息；access_token 可现在粘贴（保存时自动验证）或稍后在卡片中录入
              （TEMU 卖家中心 → 授权管理 → 选择自研应用 → 勾选接口 → 确认 → 复制 token）。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">所属应用（必选，单应用最多 {MAX_STORES_PER_APP} 家店铺）</Label>
              <Select
                items={appSelectable.map((a) => ({
                  value: a.id,
                  label: `${a.name}（${a.storeCount}/${MAX_STORES_PER_APP}）`,
                }))}
                value={adding?.appId ?? ""}
                onValueChange={(v) => setAdding((prev) => (prev ? { ...prev, appId: v ?? "" } : prev))}
              >
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue placeholder="选择应用" />
                </SelectTrigger>
                <SelectContent>
                  {appSelectable.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}（{a.storeCount}/{MAX_STORES_PER_APP}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">店铺名称（必填）</Label>
              <Input
                value={adding?.name ?? ""}
                onChange={(e) => setAdding((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
                placeholder="如 RoseBlanche 主店"
                className="h-8 text-xs"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Temu mallId（可选）</Label>
                <Input
                  value={adding?.mallId ?? ""}
                  onChange={(e) => setAdding((prev) => (prev ? { ...prev, mallId: e.target.value } : prev))}
                  placeholder="授权验证自动回填"
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Temu 店铺名（可选）</Label>
                <Input
                  value={adding?.mallName ?? ""}
                  onChange={(e) => setAdding((prev) => (prev ? { ...prev, mallName: e.target.value } : prev))}
                  placeholder="如 girl clothes"
                  className="h-8 text-xs"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">access_token（可选，粘贴后保存时自动验证）</Label>
              <Input
                value={adding?.accessToken ?? ""}
                onChange={(e) => setAdding((prev) => (prev ? { ...prev, accessToken: e.target.value } : prev))}
                placeholder="粘贴 access_token"
                className="h-8 font-mono text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdding(null)}>
              取消
            </Button>
            <Button
              disabled={submitting || !adding?.appId || !adding?.name.trim()}
              onClick={submitAdding}
            >
              {submitting ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 演示店铺卡（虚拟数据静态展示；操作由系统管理，配置应用后自动移除） */
function DemoStoreCard({ store }: { store: TemuStoreBrief }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/20 bg-background p-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {store.name}
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400">
            演示
          </span>
          {store.mallType && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {store.mallType === "semi" ? "半托" : "全托"}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {store.mallName ? `${store.mallName} · ` : ""}内置虚拟数据（不同步官方接口）
        </div>
      </div>
    </div>
  )
}

/** 应用分组：header + 组内店铺表单卡（拖拽排序） */
function AppGroup({
  app,
  stores,
  pending,
  onGroupReorder,
  onSync,
}: {
  app: TemuAppBrief
  stores: TemuStoreBrief[]
  pending: boolean
  onGroupReorder: (appId: string | null, newIds: string[]) => Promise<{ ok: boolean; error?: string | null }>
  onSync: (store: { id: string; name: string }) => void
}) {
  const appId = app.id || null
  const { ordered, rowProps, handleProps } = useDragSort({
    items: stores,
    commit: (ids) => onGroupReorder(appId, ids),
  })
  return (
    <section className="rounded-xl border">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <h4 className="text-sm font-semibold">{app.name}</h4>
        {app.testMode && (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400">
            测试模式
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          店铺 {stores.length}/{MAX_STORES_PER_APP}
        </span>
      </header>
      <div className="space-y-2 p-3">
        {ordered.map((s) => (
          <div key={s.id} {...rowProps(s.id, "")}>
            <StoreFormCard store={s} pending={pending} onSync={onSync} handleProps={handleProps(s.id)} />
          </div>
        ))}
        {stores.length === 0 && (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
            该应用下暂无店铺，点击右上「新增店铺」创建
          </p>
        )}
      </div>
    </section>
  )
}

/** 单店表单卡：折叠态摘要行；展开态字段直编 + token + 操作行 */
function StoreFormCard({
  store,
  pending,
  onSync,
  handleProps,
}: {
  store: TemuStoreBrief
  pending: boolean
  onSync: (store: { id: string; name: string }) => void
  handleProps: React.HTMLAttributes<HTMLSpanElement> & {
    "aria-label"?: string
    role?: string
    tabIndex?: number
  }
}) {
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState({
    name: store.name,
    mallId: store.mallId || "",
    mallName: store.mallName || "",
  })
  const [tokenInput, setTokenInput] = React.useState<string | null>(null)
  const [confirmAction, setConfirmAction] = React.useState<"delete" | "clear" | null>(null)
  const [, startTransition] = React.useTransition()

  const dirty =
    draft.name !== store.name ||
    draft.mallId !== (store.mallId || "") ||
    draft.mallName !== (store.mallName || "")

  const expiry = expiryHint(store.tokenExpiresAt)

  const saveDraft = () =>
    startTransition(async () => {
      const ok = await run("店铺已更新", () =>
        updateTemuStoreAction({
          id: store.id,
          name: draft.name.trim() || undefined,
          mallId: draft.mallId.trim() || null,
          mallName: draft.mallName.trim() || null,
        }),
      )
      if (ok) setOpen(false)
    })

  return (
    <div className="rounded-xl border">
      {/* 折叠态/展开态共用的标题行（行首拖拽手柄 + 折叠开关） */}
      <div className="flex w-full items-center gap-1 px-2 py-3 pl-3">
        <DragHandle handleProps={handleProps} />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown
            className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")}
          />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {store.name}
            {store.mallName && <span className="text-xs font-normal text-muted-foreground">（{store.mallName}）</span>}
            {store.mallType && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {store.mallType === "semi" ? "半托" : "全托"}
              </span>
            )}
            {!store.enabled && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">已停用</span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <TokenStateBadge state={store.tokenState} />·
            {store.mallId ? `mall:${store.mallId}` : "未绑定 mallId"} · 最近同步{" "}
            {store.lastSyncAt ? formatDateTime(store.lastSyncAt) : "从未"}
            {expiry && <span className="text-amber-600 dark:text-amber-400">{expiry}</span>}
          </div>
        </div>
        </button>
      </div>

      {open && (
        <div className="space-y-3 border-t px-3 py-3">
          <div className="flex flex-wrap items-end gap-2 pl-7">
            <div className="min-w-40 flex-1 space-y-1">
              <Label className="text-xs">店铺名称</Label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="h-8 text-xs"
              />
            </div>
            <div className="min-w-40 flex-1 space-y-1">
              <Label className="text-xs">Temu mallId</Label>
              <Input
                value={draft.mallId}
                onChange={(e) => setDraft({ ...draft, mallId: e.target.value })}
                placeholder="授权验证自动回填"
                className="h-8 text-xs"
              />
            </div>
            <div className="min-w-40 flex-1 space-y-1">
              <Label className="text-xs">Temu 店铺名</Label>
              <Input
                value={draft.mallName}
                onChange={(e) => setDraft({ ...draft, mallName: e.target.value })}
                className="h-8 text-xs"
              />
            </div>
            <Button size="sm" variant="outline" disabled={pending || !dirty} onClick={saveDraft}>
              保存
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2 pl-7">
            <Button
              size="sm"
              variant={store.tokenState === "active" ? "outline" : "default"}
              disabled={pending}
              onClick={() => setTokenInput("")}
            >
              {store.tokenState === "none" ? "录入 Token" : "重录 Token"}
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => onSync(store)}>
              <RefreshCw className="size-3.5" />
              立即同步
            </Button>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              定时同步
              <Switch
                checked={store.syncEnabled}
                disabled={pending}
                onCheckedChange={(v) =>
                  startTransition(() =>
                    void run(
                      v ? `已开启「${store.name}」定时同步` : `已暂停「${store.name}」定时同步`,
                      () => toggleTemuStoreSyncAction({ id: store.id, syncEnabled: v }),
                    ),
                  )
                }
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                startTransition(() =>
                  void run(
                    store.enabled ? `已停用「${store.name}」` : `已启用「${store.name}」`,
                    () => toggleTemuStoreAction({ id: store.id, enabled: !store.enabled }),
                  ),
                )
              }
            >
              {store.enabled ? "停用" : "启用"}
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => setConfirmAction("clear")}>
              清空数据
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              disabled={pending}
              onClick={() => setConfirmAction("delete")}
            >
              删除
            </Button>
          </div>
        </div>
      )}

      {/* access_token 录入（保存即验证） */}
      <Dialog open={tokenInput !== null} onOpenChange={(o) => !o && setTokenInput(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>录入 access_token · {store.name}</DialogTitle>
            <DialogDescription>
              TEMU 卖家中心 → 授权管理 → 选择自研应用 → 勾选接口（建议全选）→ 确认 → 复制
              token 粘贴到此。自研应用 token 有效期 365 天，过期需重新授权复制。保存时自动调用
              官方接口验证并识别全托/半托。
            </DialogDescription>
          </DialogHeader>
          <Input
            value={tokenInput ?? ""}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="粘贴 access_token"
            className="h-8 font-mono text-xs"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setTokenInput(null)}>
              取消
            </Button>
            <Button
              disabled={pending || !tokenInput?.trim()}
              onClick={() =>
                tokenInput &&
                startTransition(async () => {
                  try {
                    const r = await setTemuStoreTokenAction({
                      id: store.id,
                      accessToken: tokenInput.trim(),
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
        title={confirmAction === "delete" ? "删除店铺" : "清空同步数据"}
        description={
          confirmAction === "delete"
            ? `将删除店铺「${store.name}」及其全部数据，此操作不可恢复。`
            : `将清空店铺「${store.name}」的全部数据，店铺与 token 保留。下次同步（定时或手动）会全量重建。`
        }
        confirmText={confirmAction === "delete" ? "删除" : "清空"}
        destructive
        pending={pending}
        onConfirm={() => {
          const action = confirmAction
          if (!action) return
          startTransition(async () => {
            const ok =
              action === "delete"
                ? await run(`已删除店铺「${store.name}」`, () =>
                    deleteTemuStoreAction({ id: store.id }),
                  )
                : await run(`已清空「${store.name}」数据`, () =>
                    clearTemuStoreDataAction({ id: store.id }),
                  )
            if (ok) setConfirmAction(null)
          })
        }}
      />
    </div>
  )
}
