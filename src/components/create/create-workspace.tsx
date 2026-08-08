"use client"

import * as React from "react"
import { useActionState, useEffect } from "react"
import { Sparkles, Loader2, Image as ImageIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { BorderBeam } from "@/components/create/border-beam"
import { submitTaskAction } from "@/server/actions/create"
import type { ModelExtraConfig } from "@/db/schema"

export interface CreateModel {
  id: string
  name: string
  displayName: string
  costPerImage: number
  supportedSizes: string[] | null
  supportsReferenceImage: boolean
  maxReferenceImages: number
  apiFormat: "grs" | "jimeng"
  extraConfig: ModelExtraConfig | null
  iconUrl: string | null
}

const DEFAULT_SIZES = [
  { value: "1024x1024", label: "1:1 正方形" },
  { value: "1280x720", label: "16:9 横向" },
  { value: "720x1280", label: "9:16 竖向" },
  { value: "1536x1024", label: "3:2 横向" },
  { value: "1024x1536", label: "2:3 竖向" },
]

export function CreateWorkspace({
  models,
  creditsBalance,
}: {
  models: CreateModel[]
  creditsBalance: number
}) {
  const [modelId, setModelId] = React.useState(models[0]?.id ?? "")
  const [prompt, setPrompt] = React.useState("")
  const [imageSize, setImageSize] = React.useState("1024x1024")
  const [imageCount, setImageCount] = React.useState(1)
  const [activeTask, setActiveTask] = React.useState(false)

  const selectedModel = models.find((m) => m.id === modelId)
  const sizes =
    selectedModel?.supportedSizes && selectedModel.supportedSizes.length > 0
      ? DEFAULT_SIZES.filter((s) =>
          selectedModel.supportedSizes!.includes(s.value),
        )
      : DEFAULT_SIZES

  const totalCost = (selectedModel?.costPerImage ?? 0) * imageCount

  const [state, formAction, pending] = useActionState(
    async (_prev: unknown, formData: FormData) => {
      const res = await submitTaskAction({
        modelId: String(formData.get("modelId") ?? ""),
        prompt: String(formData.get("prompt") ?? ""),
        imageSize: String(formData.get("imageSize") ?? ""),
        imageCount: Number(formData.get("imageCount") ?? 1),
      })
      if (res.ok) {
        toast.success(
          `已提交，消耗 ${res.cost} 积分（并发上限 ${res.effectiveMaxConcurrent}）`,
        )
        setActiveTask(true)
        setPrompt("")
        return { taskId: res.taskId }
      }
      toast.error(res.error ?? "提交失败")
      return { error: res.error }
    },
    null,
  )

  // 提交后激活 Pulse 光效
  useEffect(() => {
    if (state?.taskId) {
      const timer = setTimeout(() => setActiveTask(false), 8000)
      return () => clearTimeout(timer)
    }
  }, [state])

  if (models.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed text-muted-foreground">
        暂无可用模型，请联系管理员配置
      </div>
    )
  }

  return (
    <BorderBeam active={activeTask} className="bg-card">
      <form action={formAction} className="space-y-4 p-6">
        <div className="flex items-center gap-2">
          <Sparkles className="size-5 text-primary" />
          <h2 className="text-lg font-semibold">AI 创作</h2>
          {activeTask ? (
            <Badge variant="secondary" className="ml-auto">
              <Loader2 className="mr-1 size-3 animate-spin" />
              生成中
            </Badge>
          ) : null}
        </div>

        <input type="hidden" name="modelId" value={modelId} />
        <input type="hidden" name="imageSize" value={imageSize} />
        <input type="hidden" name="imageCount" value={imageCount} />

        <div className="grid gap-2">
          <Label htmlFor="prompt">提示词</Label>
          <Textarea
            id="prompt"
            name="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="描述你想要生成的图片，如：一只在星空下奔跑的赛博朋克猫，霓虹色调，电影感"
            required
            maxLength={4000}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label>模型</Label>
            <Select value={modelId} onValueChange={(v) => setModelId(v ?? "")}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择模型">
                  {selectedModel
                    ? `${selectedModel.displayName}（${selectedModel.costPerImage} 积分/张）`
                    : "选择模型"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.displayName}（{m.costPerImage} 积分/张）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label>尺寸</Label>
            <Select value={imageSize} onValueChange={(v) => setImageSize(v ?? "1024x1024")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sizes.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-2">
          <Label>生成数量</Label>
          <div className="flex gap-2">
            {[1, 2, 3, 4].map((n) => (
              <Button
                key={n}
                type="button"
                variant={imageCount === n ? "default" : "outline"}
                size="sm"
                onClick={() => setImageCount(n)}
              >
                {n}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between border-t pt-4">
          <div className="text-sm text-muted-foreground">
            预计消耗{" "}
            <span className="font-semibold text-foreground">{totalCost}</span>{" "}
            积分 · 余额 {creditsBalance.toLocaleString("zh-CN")}
          </div>
          <Button type="submit" disabled={pending || totalCost > creditsBalance}>
            {pending ? (
              <>
                <Loader2 className="mr-1 size-4 animate-spin" />
                提交中
              </>
            ) : (
              <>
                <ImageIcon className="mr-1 size-4" />
                开始生成
              </>
            )}
          </Button>
        </div>
      </form>
    </BorderBeam>
  )
}
