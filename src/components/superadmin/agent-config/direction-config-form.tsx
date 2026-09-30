"use client"

/**
 * 单产品线配置表单（Agent 配置页 Tabs 内容）：
 * 经典全流程配置已随流程下线；塔罗展示模板流程表单（模型/阈值/参数，
 * 见 template-config-form），其余方向仅保留启停开关与占位说明；
 * 底部 sticky 操作栏含未保存提示。
 */
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { RotateCcw, Save } from "lucide-react"
import { defaultTemplateConfigFor, type DirectionConfig } from "@/lib/agent/pipelines"
import { DIRECTION_CARDS } from "@/components/agent/team"
import { cn } from "@/lib/utils"
import { TemplateConfigForm, type ChatModelOption, type ImageModelOption } from "./template-config-form"

export function DirectionConfigForm({
  draft,
  saved,
  chatModels,
  imageModels,
  saving,
  onPatch,
  onSave,
  onReset,
}: {
  draft: DirectionConfig
  saved: DirectionConfig
  chatModels: ChatModelOption[]
  imageModels: ImageModelOption[]
  saving: boolean
  onPatch: (partial: Partial<DirectionConfig>) => void
  onSave: (config: DirectionConfig) => void
  onReset: () => void
}) {
  const card = DIRECTION_CARDS[draft.direction]
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)

  return (
    <div className="space-y-4 rounded-2xl border p-5">
      {/* 头部 */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-2xl">{card.emoji}</span>
        <h2 className="text-lg font-semibold">{card.countLabel}</h2>
        <Badge
          variant="secondary"
          className={draft.enabled ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" : "bg-zinc-500/15 text-zinc-500"}
        >
          {draft.enabled ? "已开放" : "已停用"}
        </Badge>
        <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          开放
          <Switch checked={draft.enabled} onCheckedChange={(v) => onPatch({ enabled: v })} />
        </div>
      </div>

      {/* 全新部署（配置行不存在）时 templateConfig 为空——必须仍渲染完整模板
          表单（含评审团勾选），否则“保存一次生成默认配置”会被评审团预检
          拦截，形成配置自举死锁 */}
      {draft.direction === "tarot" ? (
        <TemplateConfigForm
          template={draft.templateConfig ?? defaultTemplateConfigFor("tarot")!}
          chatModels={chatModels}
          imageModels={imageModels}
          patch={(partial) =>
            onPatch({ templateConfig: { ...(draft.templateConfig ?? defaultTemplateConfigFor("tarot")!), ...partial } })
          }
        />
      ) : (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          该产品线尚未接入模板流程，暂时只需维护开放状态。
        </p>
      )}

      {/* sticky 操作栏 */}
      <div
        className={cn(
          "sticky bottom-0 -mx-5 -mb-5 flex flex-wrap items-center gap-3 rounded-b-2xl border-t bg-card/95 px-5 py-3 backdrop-blur transition-opacity",
          dirty ? "border-amber-500/40" : "border-transparent opacity-70",
        )}
      >
        <span className={cn("text-xs", dirty ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
          {dirty ? "有未保存的修改" : "无待保存修改"}
        </span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" disabled={!dirty || saving} onClick={onReset}>
            <RotateCcw className="size-3.5" />
            放弃修改
          </Button>
          <Button size="sm" disabled={!dirty || saving} onClick={() => onSave(draft)}>
            <Save className="size-3.5" />
            {saving ? "保存中…" : "保存配置"}
          </Button>
        </div>
      </div>
    </div>
  )
}
