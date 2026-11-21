"use client"

import * as React from "react"
import { toast } from "sonner"
import { ChevronDown, RefreshCw, ShieldCheck } from "lucide-react"
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
  refreshTemuStoresAction,
  toggleTemuStoreSyncAction,
  toggleTemuStoreAction,
  deleteTemuStoreAction,
  clearTemuStoreDataAction,
  reorderTemuStoresAction,
  detectTemuResidualDataAction,
  cleanTemuResidualDataAction,
  type TemuStoreBrief,
  type TemuAppBrief,
  type TemuTokenIdentityMismatch,
  type TemuResidualReport,
} from "@/server/actions/temu"
import type { TemuSyncStatus } from "@/db/schema"
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

/** 同步结果 toast（成功=各源条数；失败=首个失败源摘要）——手动排队完成后调用 */
function toastSyncOutcome(name: string, status: TemuSyncStatus) {
  if (status.ok) {
    const parts = Object.entries(status.sources)
      .map(([k, v]) => `${k.replace("api-", "")} ${v.count ?? 0}`)
      .join(" · ")
    toast.success(`「${name}」同步完成：${parts || "无数据"}`)
  } else {
    const firstErr = Object.entries(status.sources).find(([, v]) => !v.ok)
    toast.error(
      `「${name}」部分同步失败${firstErr ? `：${firstErr[0].replace("api-", "")} — ${String(firstErr[1].error ?? "").slice(0, 90)}` : ""}`,
      { duration: 6000 },
    )
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

/** token 身份比对不一致确认弹窗（防错绑）：探测到 token 归属与店铺身份不符时二次确认 */
function TokenMismatchDialog({
  data,
  pending,
  onCancel,
  onConfirm,
}: {
  data: { storeName: string; mismatch: TemuTokenIdentityMismatch } | null
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <ConfirmDialog
      open={data !== null}
      onOpenChange={(o) => !o && onCancel()}
      title="店铺身份不一致，仍要绑定？"
      description={
        data
          ? `${data.mismatch.detail}。绑定后该店铺将同步 token 归属店铺的数据，原有残留数据不会自动清理（可在店铺管理「数据体检」处理）。确认仍要绑定到店铺「${data.storeName}」？`
          : ""
      }
      confirmText="仍要绑定"
      destructive
      pending={pending}
      onConfirm={onConfirm}
    />
  )
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
  const [pending, startTransition] = React.useTransition()
  /** 新增弹窗：token 提交后走验证（不中断弹窗，验证失败留在弹窗提示） */
  const [submitting, setSubmitting] = React.useState(false)
  /** 新增流程 token 身份不一致待确认（店铺已创建、token 未落库） */
  const [addingTokenConfirm, setAddingTokenConfirm] = React.useState<{
    storeId: string
    storeName: string
    accessToken: string
    mismatch: TemuTokenIdentityMismatch
  } | null>(null)
  /** 数据体检（错绑残留检测/清理） */
  const [healthOpen, setHealthOpen] = React.useState(false)
  const [healthLoading, setHealthLoading] = React.useState(false)
  const [healthReport, setHealthReport] = React.useState<TemuResidualReport | null>(null)
  const [cleanConfirm, setCleanConfirm] = React.useState(false)
  const [cleaning, setCleaning] = React.useState(false)

  const runHealth = () => {
    setHealthOpen(true)
    setHealthLoading(true)
    void (async () => {
      try {
        setHealthReport(await detectTemuResidualDataAction())
      } catch (e) {
        toast.error((e instanceof Error ? e.message : String(e)).slice(0, 150) || "检测失败")
        setHealthOpen(false)
      } finally {
        setHealthLoading(false)
      }
    })()
  }

  const runClean = () => {
    setCleaning(true)
    void (async () => {
      try {
        const r = await cleanTemuResidualDataAction()
        if (r.ok) {
          const total = Object.values(r.counts ?? {}).reduce((s, n) => s + n, 0)
          toast.success(`已清理残留数据 ${total} 行`)
          setCleanConfirm(false)
          // 先清旧报告再重检测：若重检测 throw，弹窗不会继续展示已清掉的残留
          setHealthReport(null)
          setHealthLoading(true)
          setHealthReport(await detectTemuResidualDataAction())
        } else {
          toast.error(r.error ?? "清理失败")
        }
      } catch (e) {
        toast.error((e instanceof Error ? e.message : String(e)).slice(0, 150) || "清理失败")
      } finally {
        setHealthLoading(false)
        setCleaning(false)
      }
    })()
  }

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

  /**
   * 手动同步：action 只置排队标记（单店全量同步含官方限速冷却实测要数分钟，
   * HTTP 请求内等待会被前置反代超时掐断报 unexpected response），由 worker
   * tick 认领后台执行；本组件轮询页面数据，检测到该店 lastSyncAt 更新即弹结果
   */
  const doSync = (store: { id: string; name: string }) => {
    void (async () => {
      try {
        const r = await syncTemuStoreAction({ id: store.id })
        if (r.skipped) {
          toast.warning(`「${store.name}」未同步：${r.skipped}`)
          return
        }
        if (r.queued) {
          const cur = stores.find((s) => s.id === store.id)
          const baseline = cur?.lastSyncAt ? new Date(cur.lastSyncAt).getTime() : 0
          setSyncAwaiting((prev) => ({ ...prev, [store.id]: { baseline, t0: Date.now() } }))
          toast.info(`「${store.name}」已加入同步队列，完成后自动刷新`)
        } else {
          toast.error(`「${store.name}」同步排队失败，请稍后重试`)
        }
      } catch (e) {
        toast.error((e instanceof Error ? e.message : String(e)).slice(0, 150) || "同步失败")
      }
    })()
  }

  /** 手动同步等待中：storeId → { baseline=入队时该店 lastSyncAt 时间戳, t0=入队时刻 } */
  const [syncAwaiting, setSyncAwaiting] = React.useState<
    Record<string, { baseline: number; t0: number }>
  >({})

  // 等待期间每 5s 拉一次最新页面数据供完成检测比对：走 server action 通道
  // （revalidatePath 随响应回传新鲜 RSC）。须包 startTransition——action 响应的
  // 路由树更新只在 transition 上下文里被 React 应用（站内其他 action 同款）；
  // router.refresh() 在部分内嵌 webview 不生效（实测请求成功返回新数据但界面不动）。
  // 隐藏页定时器会被冻结：回前台时立即补一拉，完成检测马上兑现
  React.useEffect(() => {
    if (Object.keys(syncAwaiting).length === 0) return
    const poll = () =>
      startTransition(() => {
        void refreshTemuStoresAction().catch(() => {})
      })
    const timer = setInterval(poll, 5000)
    const onVisible = () => {
      if (!document.hidden) poll()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [syncAwaiting])

  // 完成检测：该店 lastSyncAt 新于入队基线即弹同步结果；8 分钟未完成提示仍在后台
  React.useEffect(() => {
    const entries = Object.entries(syncAwaiting)
    if (entries.length === 0) return
    const finished: string[] = []
    for (const [id, aw] of entries) {
      const s = stores.find((x) => x.id === id)
      if (!s) {
        // 店铺已删除等：放弃等待
        finished.push(id)
        continue
      }
      const at = s.lastSyncAt ? new Date(s.lastSyncAt).getTime() : 0
      if (at > aw.baseline) {
        finished.push(id)
        if (s.lastSyncStatus) toastSyncOutcome(s.name, s.lastSyncStatus)
      } else if (Date.now() - aw.t0 > 8 * 60_000) {
        finished.push(id)
        toast.warning(`「${s.name}」同步仍在后台进行，可稍后刷新查看结果`)
      }
    }
    if (finished.length > 0) {
      setSyncAwaiting((prev) => {
        const next = { ...prev }
        for (const id of finished) delete next[id]
        return next
      })
    }
  }, [stores, syncAwaiting])

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
          if ("needConfirm" in tokenRes && tokenRes.needConfirm) {
            // 身份不一致：店铺已创建但 token 未落库，交由确认弹窗二次确认
            setAddingTokenConfirm({
              storeId: created.store.id,
              storeName: created.store.name,
              accessToken: adding.accessToken.trim(),
              mismatch: tokenRes.mismatch,
            })
            setAdding(null)
            return
          }
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
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={pending} onClick={runHealth}>
            <ShieldCheck className="size-3.5" /> 数据体检
          </Button>
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
            syncingIds={syncAwaiting}
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
              syncingIds={syncAwaiting}
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

      {/* 新增流程 token 身份不一致二次确认（店铺已创建、token 未落库） */}
      <TokenMismatchDialog
        data={addingTokenConfirm}
        pending={submitting}
        onCancel={() => {
          toast.info("已取消绑定，店铺已创建，可稍后在卡片中录入正确的 access_token")
          setAddingTokenConfirm(null)
        }}
        onConfirm={() => {
          const req = addingTokenConfirm
          if (!req) return
          setSubmitting(true)
          void (async () => {
            try {
              const r = await setTemuStoreTokenAction({
                id: req.storeId,
                accessToken: req.accessToken,
                confirmIdentityMismatch: true,
              })
              if (r.ok) {
                toast.success(
                  `token 验证通过：${r.mallType === "semi" ? "半托店铺" : "全托店铺"}${r.mallId ? `（mall:${r.mallId}）` : ""}`,
                )
              } else {
                toast.error(`token 验证失败：${r.error ?? "未知错误"}`, { duration: 6000 })
              }
            } catch (e) {
              toast.error((e instanceof Error ? e.message : String(e)).slice(0, 150) || "保存失败")
            } finally {
              setSubmitting(false)
              setAddingTokenConfirm(null)
            }
          })()
        }}
      />

      {/* 数据体检结果（错绑残留检测与清理） */}
      <Dialog open={healthOpen} onOpenChange={(o) => !o && setHealthOpen(false)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>数据体检 · 错绑残留检测</DialogTitle>
            <DialogDescription>
              检测历史 token 错绑产生的残留数据（同一货品跨店双落且同步已冻结），可一键清理；
              正确归属店铺的数据不受影响。发货单跨店多行是官方同主体跨店可见的正常设计，不在检测范围。
            </DialogDescription>
          </DialogHeader>
          {healthLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">检测中…</p>
          ) : healthReport ? (
            <div className="max-h-96 space-y-3 overflow-y-auto text-sm">
              {healthReport.mallConflicts.length > 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
                  <p className="font-medium text-amber-700 dark:text-amber-400">
                    ⚠ 以下店铺绑定了同一 mall（需人工处理，不在自动清理范围）
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {healthReport.mallConflicts.map((c) => (
                      <li key={c.mallId}>
                        mall:{c.mallId} → {c.stores.join("、")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {!healthReport.hasResidual ? (
                <p className="py-6 text-center text-muted-foreground">
                  {healthReport.mallConflicts.length === 0
                    ? "未发现错绑残留数据 ✓"
                    : "未发现跨店残留行（仅 mall 绑定预警）"}
                </p>
              ) : (
                healthReport.stores.map((s) => (
                  <div key={s.storeId} className="rounded-lg border p-3">
                    <p className="font-medium">{s.storeName}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      残留商品 {s.productCount} 行 · SKU 映射 {s.skuCount} 行
                      {s.staleSince ? ` · 冻结于 ${formatDateTime(s.staleSince)}` : ""}
                    </p>
                    {s.sampleSns.length > 0 && (
                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                        样例货号：{s.sampleSns.join("、")}
                      </p>
                    )}
                  </div>
                ))
              )}
              {healthReport.hasResidual &&
                Object.values(healthReport.tableCounts).some((n) => n > 0) && (
                  <div className="rounded-lg bg-muted/50 p-3 text-xs">
                    <p className="font-medium">将清理以下表中的残留行：</p>
                    <p className="mt-1 font-mono text-muted-foreground">
                      {Object.entries(healthReport.tableCounts)
                        .filter(([, n]) => n > 0)
                        .map(([t, n]) => `${t} ${n} 行`)
                        .join(" · ") || "—"}
                    </p>
                  </div>
                )}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setHealthOpen(false)}>
              关闭
            </Button>
            {healthReport?.hasResidual && (
              <Button variant="destructive" disabled={cleaning} onClick={() => setCleanConfirm(true)}>
                {cleaning ? "清理中…" : "清理残留数据"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 清理残留二次确认 */}
      <ConfirmDialog
        open={cleanConfirm}
        onOpenChange={(o) => !o && setCleanConfirm(false)}
        title="清理残留数据"
        description="将删除检测到的错绑残留行（跨店双落且同步冻结的货品/销量/SKU 映射等），正确归属店铺的数据不受影响。建议清理后手动触发一次「立即同步」核对数据。此操作不可恢复。"
        confirmText="确认清理"
        destructive
        pending={cleaning}
        onConfirm={runClean}
      />
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
  syncingIds,
  onGroupReorder,
  onSync,
}: {
  app: TemuAppBrief
  stores: TemuStoreBrief[]
  pending: boolean
  /** 手动同步排队中的店铺 id（按钮转「同步中…」） */
  syncingIds: Record<string, unknown>
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
            <StoreFormCard
              store={s}
              pending={pending}
              syncing={Boolean(syncingIds[s.id])}
              onSync={onSync}
              handleProps={handleProps(s.id)}
            />
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
  syncing,
  onSync,
  handleProps,
}: {
  store: TemuStoreBrief
  pending: boolean
  /** 手动同步已排队、worker 后台执行中 */
  syncing: boolean
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
  /** token 身份比对不一致（防错绑确认）；确认后带 confirmIdentityMismatch 重发 */
  const [tokenMismatch, setTokenMismatch] = React.useState<TemuTokenIdentityMismatch | null>(null)
  const [tokenBusy, setTokenBusy] = React.useState(false)
  const [, startTransition] = React.useTransition()

  /** token 保存并验证；身份不一致先弹确认（confirmMismatch=true 为用户已确认） */
  const submitToken = (confirmMismatch = false) => {
    const accessToken = tokenInput?.trim()
    if (!accessToken) return
    setTokenBusy(true)
    startTransition(async () => {
      try {
        const r = await setTemuStoreTokenAction({
          id: store.id,
          accessToken,
          ...(confirmMismatch ? { confirmIdentityMismatch: true } : {}),
        })
        if (r.ok) {
          const typeText = r.mallType === "semi" ? "半托店铺" : "全托店铺"
          toast.success(`token 验证通过：${typeText}${r.mallId ? `（mall:${r.mallId}）` : ""}`)
          setTokenInput(null)
          setTokenMismatch(null)
        } else if ("needConfirm" in r && r.needConfirm) {
          setTokenMismatch(r.mismatch)
        } else {
          toast.error(r.error ?? "token 验证失败", { duration: 6000 })
        }
      } catch (e) {
        toast.error((e instanceof Error ? e.message : String(e)).slice(0, 150) || "保存失败")
      } finally {
        setTokenBusy(false)
      }
    })
  }

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
            <Button size="sm" variant="outline" disabled={pending || syncing} onClick={() => onSync(store)}>
              <RefreshCw className={cn("size-3.5", syncing && "animate-spin")} />
              {syncing ? "同步中…" : "立即同步"}
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
            <Button disabled={pending || tokenBusy || !tokenInput?.trim()} onClick={() => submitToken()}>
              保存并验证
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* token 身份比对不一致二次确认（防错绑）：确认后带标志重发 */}
      <TokenMismatchDialog
        data={tokenMismatch ? { storeName: store.name, mismatch: tokenMismatch } : null}
        pending={tokenBusy}
        onCancel={() => setTokenMismatch(null)}
        onConfirm={() => submitToken(true)}
      />

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
