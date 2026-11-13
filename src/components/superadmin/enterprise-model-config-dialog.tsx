"use client"

import * as React from "react"
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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { useForm, useWatch } from "react-hook-form"
import { updateEnterpriseModelConfigAction } from "@/server/actions/platform"
import type { PresetModelRow } from "@/server/actions/platform-models"
import type { PresetChatModelRow } from "@/server/actions/platform-chat-models"
import { formatPricePerMillion } from "@/lib/ai/chat/chat-model-config"

const FORMAT_LABEL: Record<string, string> = {
  openai: "OpenAI",
  jimeng: "即梦",
  gemini: "Gemini",
}

const CHAT_FORMAT_LABEL: Record<string, string> = {
  openai: "OpenAI",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
}

/** 模型配置勾选（无 zod schema：id 数组宽松 string[]，枚举由服务端兜底） */
type ModelConfigFormValues = {
  allowCustomModels: boolean
  imageModels: string[]
  chatModels: string[]
}

/** 数组元素增删（勾选 toggle） */
function toggleValue(current: string[], m: string, on: boolean): string[] {
  return on
    ? current.includes(m)
      ? current
      : [...current, m]
    : current.filter((x) => x !== m)
}

/**
 * 企业级模型配置（需求 2b）
 *
 * - allowCustomModels：是否允许企业自建私有模型
 * - visiblePresetModels：勾选该企业可见的平台生图模型（空 = 全部可见）
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
  const [serverError, setServerError] = React.useState<string | null>(null)
  const router = useRouter()

  // 「全部可见」当且仅当白名单为空：此时表单里不勾任何项（口径同改造前 defaultChecked）
  // useMemo：保持引用稳定，避免 open 重置 effect 在表单交互触发的重渲染里反复 reset
  const initialImageModels = React.useMemo(
    () =>
      !visiblePresetModels || visiblePresetModels.length === 0
        ? []
        : [...visiblePresetModels],
    [visiblePresetModels],
  )
  const initialChatModels = React.useMemo(
    () =>
      !visiblePresetChatModels || visiblePresetChatModels.length === 0
        ? []
        : [...visiblePresetChatModels],
    [visiblePresetChatModels],
  )

  const form = useForm<ModelConfigFormValues>({
    defaultValues: {
      allowCustomModels,
      imageModels: initialImageModels,
      chatModels: initialChatModels,
    },
  })
  const pending = form.formState.isSubmitting

  // 「全部可见」当且仅当未勾选任何生图模型（实时随勾选联动；useWatch 供 React Compiler 记忆化）
  const imageModels = useWatch({ control: form.control, name: "imageModels" })
  const chatModels = useWatch({ control: form.control, name: "chatModels" })
  const isAllVisible = imageModels.length === 0
  const isAllChatVisible = chatModels.length === 0

  React.useEffect(() => {
    if (open) {
      form.reset({
        allowCustomModels,
        imageModels: initialImageModels,
        chatModels: initialChatModels,
      })
      setServerError(null)
    }
  }, [open, form, allowCustomModels, initialImageModels, initialChatModels])

  async function onSubmit(values: ModelConfigFormValues) {
    setServerError(null)
    const res = await updateEnterpriseModelConfigAction({
      enterpriseId,
      allowCustomModels: values.allowCustomModels,
      visiblePresetModels: values.imageModels,
      visiblePresetChatModels: values.chatModels,
    })
    if (res.ok) {
      toast.success("模型配置已更新")
      setOpen(false)
      router.refresh()
      return
    }
    // 服务端兜底错误：统一条内联展示，不再 toast
    setServerError(res.error ?? "更新失败")
  }

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
            「{enterpriseName}」 · 自定义模型开关与可见平台生图模型
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* 自定义模型总开关 */}
            <FormField
              control={form.control}
              name="allowCustomModels"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-md border p-3">
                  <div>
                    <FormLabel className="text-sm font-medium">
                      允许企业自建私有模型
                    </FormLabel>
                    <div className="text-xs text-muted-foreground">
                      关闭后，企业管理员只能使用平台生图模型，无法新建/编辑私有模型
                    </div>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={(v) => field.onChange(v === true)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* 可见平台生图模型勾选 */}
            <FormField
              control={form.control}
              name="imageModels"
              render={({ field }) => (
                <FormItem className="rounded-md border p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <FormLabel className="text-sm font-medium">
                        可见的平台生图模型
                      </FormLabel>
                      <div className="text-xs text-muted-foreground">
                        不勾选任何项 = 全部生图模型可见
                      </div>
                    </div>
                    <Badge variant={isAllVisible ? "default" : "outline"}>
                      {isAllVisible ? "当前：全部可见" : "当前：白名单模式"}
                    </Badge>
                  </div>
                  {presetModels.length === 0 ? (
                    <div className="py-4 text-center text-xs text-muted-foreground">
                      暂无平台生图模型，请先到「平台生图模型」页创建
                    </div>
                  ) : (
                    <ScrollArea className="h-48 rounded-md border">
                      <div className="divide-y">
                        {presetModels.map((m) => (
                          <label
                            key={m.id}
                            className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-sidebar-accent/40"
                          >
                            <FormControl>
                              <Checkbox
                                checked={field.value.includes(m.id)}
                                onCheckedChange={(checked) =>
                                  field.onChange(toggleValue(field.value, m.id, checked === true))
                                }
                              />
                            </FormControl>
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
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* 可见平台预置对话模型勾选 */}
            <FormField
              control={form.control}
              name="chatModels"
              render={({ field }) => (
                <FormItem className="rounded-md border p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <FormLabel className="text-sm font-medium">
                        可见的平台预置对话模型
                      </FormLabel>
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
                              <FormControl>
                                <Checkbox
                                  checked={field.value.includes(m.id)}
                                  onCheckedChange={(checked) =>
                                    field.onChange(toggleValue(field.value, m.id, checked === true))
                                  }
                                />
                              </FormControl>
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
                  <FormMessage />
                </FormItem>
              )}
            />

            {serverError ? (
              <p className="text-sm text-destructive">{serverError}</p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "更新中…" : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
