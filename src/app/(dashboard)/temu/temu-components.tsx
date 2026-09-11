"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { useActionState } from "react"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  createTemuStoreAction,
  resetTemuStoreTokenAction,
  toggleTemuStoreAction,
  deleteTemuStoreAction,
  type TemuStoreBrief,
} from "@/server/actions/temu"

/**
 * Temu 面板客户端组件：销量趋势图（单序列）+ 店铺管理
 */

const trendConfig = { value: { label: "销量", color: "var(--chart-1)" } } satisfies ChartConfig

export function TemuSalesTrend({ data }: { data: { day: string; value: number }[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
        近 30 天暂无数据（插件上报后自动积累）
      </div>
    )
  }
  return (
    <ChartContainer config={trendConfig} className="h-[240px] w-full">
      <AreaChart data={data} margin={{ left: 4, right: 8 }}>
        <defs>
          <linearGradient id="fillTemuSales" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-value)" fillOpacity={0.6} />
            <stop offset="95%" stopColor="var(--color-value)" fillOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
        <YAxis tickLine={false} axisLine={false} tickMargin={8} width={32} />
        <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
        <Area
          dataKey="value"
          type="monotone"
          stroke="var(--color-value)"
          fill="url(#fillTemuSales)"
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  )
}

// ---------- 店铺管理 ----------

type ActionResult = { ok: boolean; error?: string }

async function wrap<T>(fn: () => Promise<T>): Promise<ActionResult> {
  try {
    await fn()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) }
  }
}

export function TemuStoreManager({ stores }: { stores: TemuStoreBrief[] }) {
  const [name, setName] = React.useState("")
  const [mallName, setMallName] = React.useState("")
  const [tokenShown, setTokenShown] = React.useState<{ name: string; token: string } | null>(null)
  const [result, setResult] = React.useState<ActionResult | null>(null)
  const [pending, startTransition] = React.useTransition()

  const onCreate = () => {
    if (!name.trim()) return
    startTransition(async () => {
      try {
        const r = await createTemuStoreAction({ name: name.trim(), mallName: mallName.trim() || undefined })
        setTokenShown({ name: r.store.name, token: r.deviceToken })
        setName("")
        setMallName("")
      } catch (e) {
        setResult({ ok: false, error: String(e).slice(0, 200) })
      }
    })
  }

  return (
    <div className="space-y-6">
      {/* 新 token 弹层（仅创建/重置时展示一次） */}
      {tokenShown && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl bg-background p-6 shadow-lg">
            <h3 className="text-lg font-semibold">「{tokenShown.name}」上报 Token</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              仅此一次明文展示：复制到 Temu Collector 插件 popup 的「添加店铺」中保存。
            </p>
            <code className="mt-3 block break-all rounded-md bg-muted p-3 font-mono text-sm">
              {tokenShown.token}
            </code>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => navigator.clipboard?.writeText(tokenShown.token)}
              >
                复制
              </Button>
              <Button onClick={() => setTokenShown(null)}>我已保存</Button>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border p-4">
        <h3 className="text-sm font-semibold">添加店铺</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="店铺名称（如：主店）"
            className="w-56"
          />
          <Input
            value={mallName}
            onChange={(e) => setMallName(e.target.value)}
            placeholder="Temu 店铺名（可选，如 RoseBlanche）"
            className="w-64"
          />
          <Button onClick={onCreate} disabled={pending || !name.trim()}>
            创建并生成 Token
          </Button>
        </div>
        {result && !result.ok && (
          <p className="mt-2 text-sm text-destructive">{result.error}</p>
        )}
      </div>

      <div className="space-y-3">
        {stores.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-3 rounded-xl border p-4">
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {s.name}
                {s.mallName && <span className="ml-2 text-sm text-muted-foreground">（{s.mallName}）</span>}
              </div>
              <div className="text-xs text-muted-foreground">
                {s.enabled ? "启用" : "已停用"} · 最近上报{" "}
                {s.lastSeenAt
                  ? new Date(s.lastSeenAt).toLocaleString("zh-CN", { hour12: false })
                  : "从未"}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  try {
                    const r = await resetTemuStoreTokenAction({ id: s.id })
                    setTokenShown({ name: s.name, token: r.deviceToken })
                  } catch (e) {
                    setResult({ ok: false, error: String(e).slice(0, 200) })
                  }
                })
              }
            >
              重置 Token
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => startTransition(async () => setResult(await wrap(() => toggleTemuStoreAction({ id: s.id, enabled: !s.enabled }))))}
            >
              {s.enabled ? "停用" : "启用"}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() => {
                if (!confirm(`删除店铺「${s.name}」及其全部采集数据？`)) return
                startTransition(async () => setResult(await wrap(() => deleteTemuStoreAction({ id: s.id }))))
              }}
            >
              删除
            </Button>
          </div>
        ))}
        {stores.length === 0 && (
          <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            还没有店铺。创建后把生成的 Token 填入插件即可开始接收数据。
          </p>
        )}
      </div>
    </div>
  )
}
