"use client"

/* 资产 URL 由受控上传接口返回，使用原生 img 兼容本地存储与 COS。 */
/* eslint-disable @next/next/no-img-element */

/**
 * art 阶段「周边资产与融合」Tab：6 项套件资产（边框/卡背/牌盒四面）的
 * 提示词加载 → 外部生图 → 上传结果 → 确认。边框强制透明 PNG（服务端校验）。
 */
import { useMemo, useRef, useState } from "react"
import { Check, Copy, ImagePlus, Loader2, Upload } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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

export function TarotAssetsPanel({
  data,
  onRefresh,
}: {
  data: TemplateWorkspaceData
  onRefresh: () => Promise<unknown>
}) {
  const { confirmTarotAsset, getTarotAssetPrompts, saveTarotAsset } = useWorkspaceActions()
  const [kind, setKind] = useState<AgentAssetKind>("border")
  const [prompt, setPrompt] = useState("")
  /** 当前 prompt 属于哪个资产类型（防止切换类型后旧提示词随上传错配入库） */
  const [promptKind, setPromptKind] = useState<AgentAssetKind | null>(null)
  const [loadingPrompt, setLoadingPrompt] = useState(false)
  const [uploading, setUploading] = useState(false)
  const loadSeqRef = useRef(0)
  const assetByKind = useMemo(() => new Map(data.assets.map((asset) => [asset.kind, asset])), [data.assets])
  const activeAsset = assetByKind.get(kind)

  const loadPrompt = async (selected: AgentAssetKind) => {
    // 最新请求序号守卫：快速切换类型时，旧请求后返回不得覆盖当前类型的提示词
    const seq = ++loadSeqRef.current
    setLoadingPrompt(true)
    try {
      const prompts = await getTarotAssetPrompts(data.run.id)
      if (seq !== loadSeqRef.current) return
      setPrompt(prompts.find((item) => item.kind === selected)?.prompt ?? "")
      setPromptKind(selected)
    } catch (error) {
      if (seq !== loadSeqRef.current) return
      toast.error(error instanceof Error ? error.message : "提示词加载失败")
    } finally {
      if (seq === loadSeqRef.current) setLoadingPrompt(false)
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
      // 只在提示词确实属于当前类型时一并保存（类型切换后、加载完成前不上传旧词）
      await saveTarotAsset({ runId: data.run.id, kind, url: result.url, source: "upload", prompt: promptKind === kind ? prompt : undefined })
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
        <CardTitle className="text-base">周边资产 · 6 项</CardTitle>
        <p className="text-xs text-muted-foreground">
          边框统一使用 AI 融合：边框作为参考图 1、无框卡面作为参考图 2。生图模型尺寸由后台配置，提示词不包含尺寸或比例。
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
          {/* 左：类型 + 提示词 + 上传 */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={kind}
                onValueChange={(value) => {
                  if (value) {
                    const next = value as AgentAssetKind
                    setKind(next)
                    void loadPrompt(next)
                  }
                }}
              >
                <SelectTrigger className="w-48" aria-label="资产类型">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((item) => (
                    <SelectItem key={item.key} value={item.key}>{item.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" disabled={loadingPrompt} onClick={() => void loadPrompt(kind)}>
                {loadingPrompt ? <Loader2 className="size-4 animate-spin" /> : <Copy className="size-4" />}
                加载模板提示词
              </Button>
            </div>
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="点击加载提示词，或自行修改后交给生图模型"
              className="min-h-40 text-xs leading-5"
            />
            <div className="flex flex-wrap items-center gap-2">
              <label
                className={`inline-flex h-8 cursor-pointer items-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground ${uploading ? "pointer-events-none opacity-50" : ""}`}
              >
                {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                上传生成结果
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
              {activeAsset && (
                <Button size="sm" variant="outline" onClick={() => void confirm()}>
                  <Check className="size-4" />
                  确认此资产
                </Button>
              )}
            </div>
          </div>

          {/* 右：当前资产预览 */}
          <div className="rounded-xl border bg-muted/20 p-3">
            <p className="mb-2 text-xs font-medium">当前资产</p>
            {activeAsset ? (
              <>
                <div className="aspect-[3/4] overflow-hidden rounded-lg bg-muted">
                  <img
                    src={activeAsset.url}
                    alt={KINDS.find((item) => item.key === kind)?.title ?? kind}
                    className="size-full object-contain"
                  />
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="truncate text-xs">{activeAsset.name ?? kind}</span>
                  <Badge variant="secondary">
                    {String((activeAsset.meta as { status?: string } | null)?.status ?? "uploaded")}
                  </Badge>
                </div>
              </>
            ) : (
              <div className="flex aspect-[3/4] flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-xs text-muted-foreground">
                <ImagePlus className="size-6" />
                尚未上传
              </div>
            )}
          </div>
        </div>

        {/* 底：6 项资产状态切换 */}
        <div className="grid gap-2 sm:grid-cols-3">
          {KINDS.map((item) => {
            const asset = assetByKind.get(item.key)
            const status = (asset?.meta as { status?: string } | null)?.status
            return (
              <button
                type="button"
                key={item.key}
                onClick={() => {
                  setKind(item.key)
                  void loadPrompt(item.key)
                }}
                className="flex items-center justify-between rounded-lg border px-3 py-2 text-left text-xs hover:border-violet-400"
              >
                <span>{item.title}</span>
                <Badge variant="secondary" className={status === "confirmed" ? "bg-emerald-500/15 text-emerald-700" : ""}>
                  {status === "confirmed" ? "已确认" : asset ? "待确认" : "待准备"}
                </Badge>
              </button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
