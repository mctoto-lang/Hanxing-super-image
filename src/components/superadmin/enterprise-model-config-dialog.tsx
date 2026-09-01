"use client"

import * as React from "react"
import { useActionState } from "react"
import { Cpu } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { updateEnterpriseModelConfigAction } from "@/server/actions/platform"
import type { PresetModelRow } from "@/server/actions/platform-models"
import type { PresetChatModelRow } from "@/server/actions/platform-chat-models"
import { formatPricePerMillion } from "@/lib/ai/chat/chat-model-config"

const FORMAT_LABEL: Record<string, string> = {
  openai: "OpenAI",
  jimeng: "即梦",
}

const CHAT_FORMAT_LABEL: Record<string, string> = {
  openai: "OpenAI",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
}

/**
 * 企业级模型配置（需求 2b）
 *
 * - allowCustomModels：是否允许企业自建私有模型
 * - visiblePresetModels：勾选该企业可见的平台预置模型（空 = 全部可见）
 * - visiblePresetChatModels：同上，作用于平台预置对话模型
 *
 * 语义：当 visible 列表为空（不勾任何），表示「全部预置可见」；
 * 勾选任意项后，仅勾选的可见。
 */
export function EnterpriseModelConfigDialog({
  enterpriseId,
  enterpriseName,
  allowCustomModels,
  visiblePresetModels,
  presetModels,
  visiblePresetChatModels,
  presetChatModels,
}: {
  enterpriseId: string
  enterpriseName: string
  allowCustomModels: boolean
  visiblePresetModels: string[]
  presetModels: PresetModelRow[]
  visiblePresetChatModels: string[]
  presetChatModels: PresetChatModelRow[]
}) {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()

  const [state, formAction, pending] = useActionState(
    async (_prev: unknown, formData: FormData) => {
      const allow = formData.get("allowCustomModels") === "on"
      const checked = presetModels
        .filter((m) => formData.get(`pm_${m.id}`) === "on")
        .map((m) => m.id)
      const checkedChat = presetChatModels
        .filter((m) => formData.get(`pcm_${m.id}`) === "on")
        .map((m) => m.id)
      const res = await updateEnterpriseModelConfigAction({
        enterpriseId,
        allowCustomModels: allow,
        visiblePresetModels: checked,
        visiblePresetChatModels: checkedChat,
      })
      if (res.ok) {
        toast.success("模型配置已更新")
        setOpen(false)
        router.refresh()
        return null
      }
      toast.error(res.error ?? "更新失败")
      return { error: res.error }
    },
    null,
  )

  // 「全部可见」当且仅当未勾选任何预置模型
  const isAllVisible =
    !visiblePresetModels || visiblePresetModels.length === 0
  const isAllChatVisible =
    !visiblePresetChatModels || visiblePresetChatModels.length === 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Cpu className="size-4" />
            模型配置
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>企业模型配置</DialogTitle>
          <DialogDescription>
            「{enterpriseName}」 · 自定义模型开关与可见平台预置模型
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          {/* 自定义模型总开关 */}
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <div className="text-sm font-medium">允许企业自建私有模型</div>
              <div className="text-xs text-muted-foreground">
                关闭后，企业管理员只能使用平台预置模型，无法新建/编辑私有模型
              </div>
            </div>
            <Switch
              name="allowCustomModels"
              defaultChecked={allowCustomModels}
            />
          </div>

          {/* 可见平台预置模型勾选 */}
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">可见的平台预置模型</div>
                <div className="text-xs text-muted-foreground">
                  不勾选任何项 = 全部预置模型可见
                </div>
              </div>
              <Badge variant={isAllVisible ? "default" : "outline"}>
                {isAllVisible ? "当前：全部可见" : "当前：白名单模式"}
              </Badge>
            </div>
            {presetModels.length === 0 ? (
              <div className="py-4 text-center text-xs text-muted-foreground">
                暂无平台预置模型，请先到「平台预置模型」页创建
              </div>
            ) : (
              <ScrollArea className="h-48 rounded-md border">
                <div className="divide-y">
                  {presetModels.map((m) => (
                    <label
                      key={m.id}
                      className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-sidebar-accent/40"
                    >
                      <Checkbox
                        name={`pm_${m.id}`}
                        defaultChecked={
                          !isAllVisible && visiblePresetModels.includes(m.id)
                        }
                      />
                      <span className="flex-1">
                        <span className="font-medium">{m.displayName}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {m.name}
                        </span>
                      </span>
                      <Badge variant="outline" className="text-xs">
                        {FORMAT_LABEL[m.apiFormat] ?? m.apiFormat}
                      </Badge>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {m.costPerImage}/张
                      </span>
                    </label>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>

          {/* 可见平台预置对话模型勾选 */}
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">可见的平台预置对话模型</div>
                <div className="text-xs text-muted-foreground">
                  不勾选任何项 = 全部预置对话模型可见（AI 对话页）
                </div>
              </div>
              <Badge variant={isAllChatVisible ? "default" : "outline"}>
                {isAllChatVisible ? "当前：全部可见" : "当前：白名单模式"}
              </Badge>
            </div>
            {presetChatModels.length === 0 ? (
              <div className="py-4 text-center text-xs text-muted-foreground">
                暂无平台预置对话模型，请先到「对话模型」页创建
              </div>
            ) : (
              <ScrollArea className="h-48 rounded-md border">
                <div className="divide-y">
                  {presetChatModels.map((m) => {
                    const free =
                      m.inputPriceCenticredits <= 0 && m.outputPriceCenticredits <= 0
                    return (
                      <label
                        key={m.id}
                        className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-sidebar-accent/40"
                      >
                        <Checkbox
                          name={`pcm_${m.id}`}
                          defaultChecked={
                            !isAllChatVisible && visiblePresetChatModels.includes(m.id)
                          }
                        />
                        <span className="flex-1">
                          <span className="font-medium">{m.displayName}</span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {m.name}
                          </span>
                        </span>
                        <Badge variant="outline" className="text-xs">
                          {CHAT_FORMAT_LABEL[m.formatType] ?? m.formatType}
                        </Badge>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {free
                            ? "免费"
                            : `${formatPricePerMillion(m.inputPriceCenticredits)}/${formatPricePerMillion(m.outputPriceCenticredits)}·百万`}
                        </span>
                      </label>
                    )
                  })}
                </div>
              </ScrollArea>
            )}
          </div>

          {state?.error ? (
            <p className="text-sm text-destructive">{state.error}</p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "更新中..." : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
