"use client"

/* 资产 URL 由受控上传接口返回，使用原生 img 兼容本地存储与 COS。 */
/* eslint-disable @next/next/no-img-element */

/**
 * art 阶段「周边资产」Tab：6 项套件资产（边框/卡背/牌盒四面）——与卡面
 * 生产一致的显示与流程：
 * - 上半部：卡面同款方形卡片网格（状态徽标：待生成 / AI 处理中 /
 *   AI 评审中 / 待确认（含评审分/兜底标记）/ 已确认 / 评审未过）；
 * - 流程：每项独立提示词 AI 生成 → AI 评审（及格线沿用创建时设定，
 *   未过自动重试，耗尽按历史最优兜底）→ 人工确认；上传兜底保留；
 * - 下半部：选中项详情（预览 + 评审分理由 + 提示词编辑与操作按钮）。
 */
import { useEffect, useMemo, useState } from "react"
import { Check, ImagePlus, Loader2, RefreshCw, Sparkles, Upload } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { CARD_SQUARE_THUMB_CLASS } from "./card-thumb-grid"
import type { AgentAssetKind } from "@/lib/agent/assets"
import type { TemplateWorkspaceData } from "./use-template-workspace"
import { useWorkspaceActions } from "./workspace-actions"

const KINDS: { key: AgentAssetKind; title: string }[] = [
  { key: "border", title: "透明卡牌边框" },
  { key: "back", title: "卡背" },
  { key: "box_front", title: "牌盒正面" },
  { key: "box_back", title: "牌盒背面" },
  { key: "box_side", title: "牌盒侧面" },
  { key: "box_top", title: "牌盒顶面" },
]

type WorkspaceAsset = TemplateWorkspaceData["assets"][number]

function metaOf(asset: WorkspaceAsset): Record<string, unknown> {
  return asset.meta && typeof asset.meta === "object" && !Array.isArray(asset.meta)
    ? (asset.meta as Record<string, unknown>)
    : {}
}

/**
 * 每项资产的展示行（data.assets 按 createdAt 升序，倒序即最新在前）：
 * 取最新一条非「评审未过」行，全部被拒时回退最新一条。稳态（无更新的
 * 待确认/评审中行）与服务端交付 ZIP 选行（getTarotDeliverablesAction 的
 * 「最新已确认，否则最新一条」）一致；已确认后重新 AI 生成或上传兜底
 * 出现更新的行时优先展示新行，使其可确认、确认后进入交付 ZIP；兜底
 * 场景展示历史最优（兜底待确认行）而非落选的最新一次尝试。
 */
function displayAssetOf(assets: WorkspaceAsset[], kind: AgentAssetKind): WorkspaceAsset | null {
  const latestFirst = [...assets.filter((asset) => asset.kind === kind)].reverse()
  return latestFirst.find((asset) => metaOf(asset).status !== "rejected") ?? latestFirst[0] ?? null
}

/** 网格卡状态徽标 */
function AssetStatusBadge({
  asset,
  processing,
}: {
  asset: WorkspaceAsset | null
  processing: boolean
}) {
  if (processing) {
    return (
      <Badge variant="secondary" className="gap-1 bg-violet-500/15 text-violet-600 dark:text-violet-300">
        <Loader2 className="size-3 animate-spin" /> AI 处理中
      </Badge>
    )
  }
  const meta = asset ? metaOf(asset) : {}
  const status = meta.status as string | undefined
  if (status === "confirmed") {
    return <Badge variant="secondary" className="bg-emerald-500/15 text-emerald-700">已确认</Badge>
  }
  if (status === "reviewing") {
    return (
      <Badge variant="secondary" className="gap-1 bg-sky-500/15 text-sky-600 dark:text-sky-300">
        <Loader2 className="size-3 animate-spin" /> AI 评审中
      </Badge>
    )
  }
  if (status === "uploaded") {
    const score = typeof meta.reviewScore === "number" ? meta.reviewScore : null
    return (
      <Badge variant="secondary" className={cn(score !== null && score < 75 && "bg-amber-500/15 text-amber-700")}>
        {meta.fallback ? `兜底待确认${score !== null ? `（${score}分）` : ""}` : score !== null ? `待确认（${score}分）` : "待确认"}
      </Badge>
    )
  }
  if (status === "rejected") {
    const score = typeof meta.reviewScore === "number" ? meta.reviewScore : null
    return <Badge variant="secondary" className="bg-red-500/15 text-red-600 dark:text-red-300">评审未过{score !== null ? `（${score}分）` : ""}</Badge>
  }
  return <Badge variant="secondary">待生成</Badge>
}

export function TarotAssetsPanel({
  data,
  onRefresh,
}: {
  data: TemplateWorkspaceData
  onRefresh: () => Promise<unknown>
}) {
  const { confirmTarotAsset, getTarotAssetPrompts, saveTarotAsset, requestTarotAssetGeneration } = useWorkspaceActions()
  const [kind, setKind] = useState<AgentAssetKind>("border")
  /** 每项独立提示词（模板词加载后可编辑） */
  const [prompts, setPrompts] = useState<Partial<Record<AgentAssetKind, string>>>({})
  const [templatePrompts, setTemplatePrompts] = useState<Partial<Record<AgentAssetKind, string>>>({})
  const [loadingPrompts, setLoadingPrompts] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // 进入面板一次性加载全部模板提示词
  useEffect(() => {
    setLoadingPrompts(true)
    getTarotAssetPrompts(data.run.id)
      .then((list) => {
        const next: Partial<Record<AgentAssetKind, string>> = {}
        for (const item of list) next[item.kind] = item.prompt
        setTemplatePrompts(next)
        setPrompts((current) => {
          const merged = { ...next }
          for (const key of Object.keys(current) as AgentAssetKind[]) {
            if (current[key]?.trim()) merged[key] = current[key]
          }
          return merged
        })
      })
      .catch(() => toast.error("模板提示词加载失败，可手动输入或刷新重试"))
      .finally(() => setLoadingPrompts(false))
  }, [data.run.id, getTarotAssetPrompts])

  const generating = data.run.pendingAction?.kind === "asset_gen"
  const generatingKinds = new Set(
    generating ? (data.run.pendingAction?.assetTasks ?? []).map((task) => task.kind) : [],
  )
  const busy = data.run.status === "queued" || data.run.status === "running"

  const displayByKind = useMemo(() => {
    const map = new Map<AgentAssetKind, WorkspaceAsset | null>()
    for (const item of KINDS) map.set(item.key, displayAssetOf(data.assets, item.key))
    return map
  }, [data.assets])

  const activeAsset = displayByKind.get(kind) ?? null
  const activeMeta = activeAsset ? metaOf(activeAsset) : {}
  const currentPrompt = prompts[kind] ?? ""

  const generateOne = async (target: AgentAssetKind, prompt: string) => {
    const text = prompt.trim()
    if (text.length < 10) {
      toast.error("提示词太短（至少 10 字），请先填写或加载模板提示词")
      return
    }
    setSubmitting(true)
    try {
      await requestTarotAssetGeneration({ runId: data.run.id, tasks: [{ kind: target, prompt: text }] })
      await onRefresh()
      toast.success(`已提交「${KINDS.find((item) => item.key === target)?.title}」AI 生成`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "提交生成失败")
    } finally {
      setSubmitting(false)
    }
  }

  const generateAll = async () => {
    const tasks = KINDS.map((item) => ({
      kind: item.key,
      prompt: (prompts[item.key] ?? templatePrompts[item.key] ?? "").trim(),
    }))
    if (tasks.some((task) => task.prompt.length < 10)) {
      toast.error("尚有资产提示词未加载/为空，请稍候或先加载模板提示词")
      return
    }
    setSubmitting(true)
    try {
      await requestTarotAssetGeneration({ runId: data.run.id, tasks })
      await onRefresh()
      toast.success("已提交全部 6 项周边资产 AI 生成")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "提交生成失败")
    } finally {
      setSubmitting(false)
    }
  }

  const upload = async (file: File) => {
    setUploading(true)
    try {
      const form = new FormData()
      form.append("file", file)
      const response = await fetch("/api/upload", { method: "POST", body: form })
      if (!response.ok) throw new Error("图片上传失败")
      const result = await response.json() as { url?: string }
      if (!result.url) throw new Error("上传接口未返回图片地址")
      await saveTarotAsset({
        runId: data.run.id,
        kind,
        url: result.url,
        source: "upload",
        prompt: prompts[kind]?.trim() || undefined,
      })
      await onRefresh()
      toast.success(`${KINDS.find((item) => item.key === kind)?.title}已上传`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "上传失败")
    } finally {
      setUploading(false)
    }
  }

  const confirm = async () => {
    if (!activeAsset) return
    try {
      await confirmTarotAsset({ runId: data.run.id, assetId: activeAsset.id })
      await onRefresh()
      toast.success("资产已确认")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "确认失败")
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">周边资产 · 6 项</CardTitle>
          <Button
            size="sm"
            disabled={submitting || busy || loadingPrompts || generating}
            onClick={() => void generateAll()}
          >
            {submitting || generating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            一键生成全部 6 项
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          与卡面生产同流程：AI 生成 → AI 评审（及格线沿用创建时设定，未过自动重试，耗尽按历史最优兜底）→ 人工确认。批量按 边框 → 卡背 → 盒正面 → 其余盒面 顺序执行。
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 上：6 项网格（卡面生产同款方形卡 + 状态徽标） */}
        <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-6">
          {KINDS.map((item) => {
            const asset = displayByKind.get(item.key) ?? null
            const processing = generatingKinds.has(item.key)
            return (
              <button
                type="button"
                key={item.key}
                onClick={() => setKind(item.key)}
                className={cn(
                  CARD_SQUARE_THUMB_CLASS,
                  "text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60",
                  item.key === kind && "border-violet-500/60",
                )}
              >
                <div className="relative aspect-square w-full overflow-hidden rounded-md bg-muted">
                  {asset?.url ? (
                    <img src={asset.url} alt={item.title} className="size-full object-contain" />
                  ) : (
                    <div className="flex size-full flex-col items-center justify-center gap-1 text-[10px] text-muted-foreground">
                      <ImagePlus className="size-5" />
                      {processing ? "生成中" : "未生成"}
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between gap-1 px-0.5 pb-0.5 pt-1">
                  <span className="min-w-0 flex-1 truncate text-[10px] font-medium">{item.title}</span>
                  <AssetStatusBadge asset={asset} processing={processing} />
                </div>
              </button>
            )
          })}
        </div>

        {/* 下：选中项详情 */}
        <div className="grid gap-4 border-t pt-4 lg:grid-cols-[200px_minmax(0,1fr)]">
          {/* 左：预览 + 评审信息 */}
          <div className="space-y-2">
            <div className="aspect-square overflow-hidden rounded-lg border bg-muted">
              {activeAsset?.url ? (
                <img
                  src={activeAsset.url}
                  alt={KINDS.find((item) => item.key === kind)?.title ?? kind}
                  className="size-full object-contain"
                />
              ) : (
                <div className="flex size-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                  <ImagePlus className="size-6" />
                  尚未生成 / 上传
                </div>
              )}
            </div>
            {activeAsset && typeof activeMeta.reviewScore === "number" && (
              <div className="rounded-lg border bg-muted/30 p-2 text-[11px] leading-4">
                <p className="font-medium">
                  AI 评审：{activeMeta.reviewScore} 分
                  {activeMeta.fallback ? "（兜底）" : ""}
                </p>
                {typeof activeMeta.reviewReason === "string" && activeMeta.reviewReason && (
                  <p className="mt-1 text-muted-foreground">{activeMeta.reviewReason}</p>
                )}
              </div>
            )}
          </div>

          {/* 右：提示词 + 操作 */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                {KINDS.find((item) => item.key === kind)?.title}
              </span>
              <AssetStatusBadge asset={activeAsset} processing={generatingKinds.has(kind)} />
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                disabled={loadingPrompts}
                onClick={() =>
                  setPrompts((current) => ({ ...current, [kind]: templatePrompts[kind] ?? current[kind] ?? "" }))
                }
              >
                <RefreshCw className="size-3" />
                重置模板词
              </Button>
            </div>
            <Textarea
              value={currentPrompt}
              onChange={(event) => setPrompts((current) => ({ ...current, [kind]: event.target.value }))}
              placeholder={loadingPrompts ? "正在加载模板提示词…" : "填写该项资产的生图提示词（可先加载模板词再修改）"}
              className="min-h-36 text-xs leading-5"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={submitting || busy || generating || currentPrompt.trim().length < 10}
                onClick={() => void generateOne(kind, currentPrompt)}
              >
                {generatingKinds.has(kind) ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                AI 生成此资产
              </Button>
              <label
                className={`inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors hover:bg-muted ${uploading ? "pointer-events-none opacity-50" : ""}`}
              >
                {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                上传成图（兜底）
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  disabled={uploading}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void upload(file)
                    event.currentTarget.value = ""
                  }}
                />
              </label>
              {activeAsset && activeMeta.status !== "confirmed" && (
                <Button size="sm" variant="outline" onClick={() => void confirm()}>
                  <Check className="size-4" />
                  确认此资产
                </Button>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
