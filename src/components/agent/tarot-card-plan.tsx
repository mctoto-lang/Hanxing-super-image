"use client"

/**
 * prompt 阶段：78 张卡牌内容清单编辑（搜索 + 牌义/画面构想逐张保存），
 * 全部确认后进入 art 生产阶段。
 */
import { useMemo, useState } from "react"
import { Check, Loader2, Save, Search } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { TemplateWorkspaceData } from "./use-template-workspace"
import { useWorkspaceActions } from "./workspace-actions"

export function TarotCardPlan({
  data,
  busy,
  onRefresh,
}: {
  data: TemplateWorkspaceData
  busy: boolean
  onRefresh: () => Promise<unknown>
}) {
  const { confirmTarotCardPlan, updateTarotCardPlanItem } = useWorkspaceActions()
  const [query, setQuery] = useState("")
  const [activeId, setActiveId] = useState<string | null>(data.items[0]?.id ?? null)
  const [saving, setSaving] = useState(false)
  const items = useMemo(
    () =>
      data.items.filter(
        (item) =>
          !query.trim() ||
          (item.name ?? "").includes(query.trim()) ||
          String(item.index + 1) === query.trim(),
      ),
    [data.items, query],
  )
  const active = data.items.find((item) => item.id === activeId) ?? items[0]
  const [meaning, setMeaning] = useState(active?.meaning ?? "")
  const [visualBrief, setVisualBrief] = useState(active?.visualBrief ?? "")

  const choose = (id: string) => {
    const item = data.items.find((candidate) => candidate.id === id)
    if (!item) return
    setActiveId(id)
    setMeaning(item.meaning ?? "")
    setVisualBrief(item.visualBrief ?? "")
  }

  const save = async () => {
    if (!active) return
    setSaving(true)
    try {
      await updateTarotCardPlanItem({ runId: data.run.id, itemId: active.id, meaning, visualBrief })
      toast.success(`${active.name} 已保存`)
      await onRefresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  const confirm = async () => {
    setSaving(true)
    try {
      await confirmTarotCardPlan({ runId: data.run.id })
      toast.success("卡牌清单已确认，开始生成风格小样")
      await onRefresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "确认失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">78 张卡牌内容清单</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              先确认牌义和画面构想，生图阶段不会生成牌名、文字或数字。
            </p>
          </div>
          <Badge variant="secondary">{data.items.length}/78 已规划</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        {/* 左：搜索 + 清单 */}
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索牌名或序号"
              className="pl-8"
            />
          </div>
          <div className="max-h-[520px] space-y-1 overflow-y-auto pr-1">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => choose(item.id)}
                className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs ${
                  item.id === active?.id ? "bg-violet-500/10 text-violet-700" : "hover:bg-muted"
                }`}
              >
                <span className="truncate">{item.index + 1}. {item.name}</span>
                {item.meaning && <Check className="size-3.5 shrink-0 text-emerald-500" />}
              </button>
            ))}
          </div>
        </div>

        {/* 右：当前卡编辑 */}
        <div className="space-y-4">
          {active ? (
            <>
              <div>
                <p className="text-sm font-medium">
                  第 {active.index + 1} 张 · {active.name}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {active.status === "pending" ? "待确认" : active.status}
                </p>
              </div>
              <div className="space-y-2">
                <label htmlFor="card-meaning" className="text-xs font-medium">牌义</label>
                <Textarea
                  id="card-meaning"
                  value={meaning}
                  onChange={(event) => setMeaning(event.target.value)}
                  className="min-h-24"
                  disabled={busy || saving}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="card-visual-brief" className="text-xs font-medium">画面构想</label>
                <Textarea
                  id="card-visual-brief"
                  value={visualBrief}
                  onChange={(event) => setVisualBrief(event.target.value)}
                  className="min-h-32"
                  disabled={busy || saving}
                />
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" disabled={busy || saving} onClick={() => void save()}>
                  <Save className="size-4" />
                  保存此张
                </Button>
                <Button disabled={busy || saving || data.items.length !== 78} onClick={() => void confirm()}>
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  确认清单，开始生产
                </Button>
              </div>
            </>
          ) : (
            <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
              暂无卡牌计划
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
