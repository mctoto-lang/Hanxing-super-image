"use client"

/**
 * 风格规范方向选择视图
 *
 * 风格策划根据《设计简报》【风格简报】与参考图生成 3 个候选《风格规范书》
 * （名称 / 概念 / 固定风格提示词（选定后逐字拼接到 78 张每张提示词末尾）/
 * 世界观 / 四花色映射 / 色调 / 每方向 1 张 AI 示例图 / 3 张示例牌场景）。
 * 用户选中一个并可附补充意见后确认；不满意可附意见「换一批」（会重新
 * 生成 3 张示例图，消耗生图积分）。
 *
 * 两种使用场景（variant）：
 * - "style"（新流程）：draft 阶段第一步——选定后开始撰写 78 张画面提示词；
 * - "legacy"（存量 run）：旧 world 阶段的方向选择，行为与旧版一致。
 */
import { useState } from "react"
import { AlertTriangle, Check, ChevronDown, FileText, ImageOff, Loader2, RefreshCw, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { AgentTemplateDirection } from "@/lib/agent/graph"
import type { RunTemplateAction } from "./tarot-stage-clarify"
import type { TemplateWorkspaceData } from "./use-template-workspace"
import { useWorkspaceActions } from "./workspace-actions"

export function WorldStage({
  data,
  busy,
  runAction,
  variant = "legacy",
}: {
  data: TemplateWorkspaceData
  busy: boolean
  runAction: RunTemplateAction
  /** style = 新流程（风格规范 3 选 1 后写初稿）；legacy = 存量 world 阶段 */
  variant?: "legacy" | "style"
}) {
  const { run } = data
  const { regenerateDirections, regenerateStyleSpec, retryTemplateAction, selectTemplateDirection } =
    useWorkspaceActions()
  const directions = run.directions ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [feedback, setFeedback] = useState("")
  const generating =
    busy && (run.pendingAction?.kind === "gen_style_spec" || run.pendingAction?.kind === "gen_directions")
  const selected = directions.find((direction) => direction.id === selectedId) ?? null

  const texts =
    variant === "style"
      ? {
          title: "选择一个《风格规范书》方向",
          description: "风格策划根据你的简报与参考图拟定了 3 份风格规范（各附 1 张示例图，直观预览该方向下的卡面效果）。选定后该方向的固定风格提示词会逐字拼接到 78 张每张画面提示词的末尾，统一整套画面风格。",
          confirm: "确认方向，开始撰写提示词",
          generatingText: "风格策划正在拟定风格规范方向与示例图…",
          regenerating: "风格策划正在重新拟定",
          confirmedToastPrefix: "已确认风格规范「",
        }
      : {
          title: "选择一个内容方向",
          description: "世界观策划根据你的简报构思了 3 个方向。选定后，整套 78 张牌、卡背和牌盒都会沿用这个世界观。",
          confirm: "确认方向，进入提示词设计",
          generatingText: "世界观策划正在构思方向…",
          regenerating: "世界观策划正在重新构思",
          confirmedToastPrefix: "已确认内容方向「",
        }

  return (
    <div className="space-y-4">
      {run.brief && (
        <Collapsible className="rounded-xl border bg-muted/20">
          <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-xl border bg-background px-4 py-2.5 text-left text-sm font-medium shadow-xs transition-colors hover:bg-muted/60">
            <span className="inline-flex min-w-0 items-center gap-2">
              <FileText className="size-4 shrink-0 text-emerald-500" />
              <span className="truncate">查看已确认的《创作简报》</span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="whitespace-pre-wrap border-t px-4 py-3 text-xs leading-6 text-muted-foreground">{run.brief}</p>
          </CollapsibleContent>
        </Collapsible>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4 text-violet-500" />
            {texts.title}
          </CardTitle>
          <CardDescription>{texts.description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {generating || directions.length === 0 ? (
            <div className="space-y-3" aria-live="polite">
              <div className="grid gap-3 md:grid-cols-3">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="flex h-64 flex-col gap-3 rounded-xl border p-4">
                    <div className="h-5 w-24 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-full animate-pulse rounded bg-muted" />
                    <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
                    <div className="mt-auto flex items-center gap-2 text-xs text-muted-foreground">
                      {index === 0 && generating && (
                        <>
                          <Loader2 className="size-3.5 animate-spin text-violet-500" />
                          {texts.generatingText}
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {/* 空态可操作：失败/未开始时在主区暴露原因与重试入口，
                  不让用户停在无法推进的骨架屏上（重试不再只靠顶部横幅） */}
              {!generating && (
                <div className="space-y-2 rounded-xl border border-dashed p-4">
                  {run.error ? (
                    <p className="flex items-start gap-2 break-all text-xs text-red-500">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      {run.error}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      尚未生成候选方向{variant === "style" ? "（简报确认后会自动生成；若未开始可手动触发）" : ""}。
                    </p>
                  )}
                  <div className="flex justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        // 有保留的失败动作优先原样重试；否则重新排队生成候选
                        if (run.error && run.pendingAction) {
                          void runAction(() => retryTemplateAction(run.id), "已重新提交")
                        } else if (variant === "style") {
                          void runAction(
                            () => regenerateStyleSpec({ runId: run.id }),
                            "风格策划正在拟定候选方向",
                          )
                        } else {
                          void runAction(
                            () => regenerateDirections({ runId: run.id }),
                            "世界观策划正在重新构思",
                          )
                        }
                      }}
                    >
                      <RefreshCw className="size-3.5" />
                      {run.error ? "重试生成候选方向" : "生成候选方向"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-3">
              {directions.map((direction) => (
                <DirectionCard
                  key={direction.id}
                  direction={direction}
                  selected={direction.id === selectedId}
                  disabled={busy}
                  onSelect={() => setSelectedId(direction.id === selectedId ? null : direction.id)}
                />
              ))}
            </div>
          )}

          {selected && !busy && (
            <div className="space-y-2 rounded-xl border border-violet-500/40 bg-violet-500/5 p-4">
              <p className="text-sm font-medium">已选择「{selected.name}」</p>
              <label htmlFor="direction-note" className="text-xs text-muted-foreground">
                补充意见（可选），例如想保留或调整的元素
              </label>
              <Textarea
                id="direction-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                className="min-h-16"
                placeholder="例如：保留潮汐意象，但人物改成动物拟人"
              />
              <div className="flex justify-end">
                <Button
                  onClick={() =>
                    void runAction(
                      () =>
                        selectTemplateDirection({
                          runId: run.id,
                          directionId: selected.id,
                          note: note.trim() || undefined,
                        }),
                      `${texts.confirmedToastPrefix}${selected.name}」`,
                    )
                  }
                >
                  <Check className="size-4" />
                  {texts.confirm}
                </Button>
              </div>
            </div>
          )}

          {!generating && directions.length > 0 && (
            <div className="space-y-2 rounded-xl border border-dashed p-4">
              <label htmlFor="direction-feedback" className="text-sm font-medium">
                都不满意？告诉风格策划要怎么调整
              </label>
              <Textarea
                id="direction-feedback"
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                className="min-h-16"
                placeholder="例如：想要更东方一些、更明亮治愈，或者以动物为主角"
                disabled={busy}
              />
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    const ok = await runAction(
                      () =>
                        variant === "style"
                          ? regenerateStyleSpec({ runId: run.id, feedback: feedback.trim() || undefined })
                          : regenerateDirections({ runId: run.id, feedback: feedback.trim() || undefined }),
                      texts.regenerating,
                    )
                    if (ok) {
                      setFeedback("")
                      setSelectedId(null)
                    }
                  }}
                >
                  <RefreshCw className="size-4" />
                  换一批方向
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function DirectionCard({
  direction,
  selected,
  disabled,
  onSelect,
}: {
  direction: AgentTemplateDirection
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border transition-colors",
        selected ? "border-violet-500 bg-violet-500/5 ring-1 ring-violet-500" : "hover:border-violet-300",
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        disabled={disabled}
        onClick={onSelect}
        className="flex flex-1 flex-col gap-2 p-4 text-left disabled:cursor-not-allowed"
      >
        {/* 方向示例图（AI 按该方向风格 + 首张示例牌场景生成；失败/存量方向缺省占位） */}
        {direction.exampleImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- 平台存储 URL（运行时动态），非静态资源
          <img
            src={direction.exampleImageUrl}
            alt={`方向「${direction.name}」示例图`}
            className="aspect-[2/3] w-full rounded-lg border object-cover"
          />
        ) : (
          <div className="flex aspect-[2/3] w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed bg-muted/30 text-muted-foreground">
            <ImageOff className="size-5 opacity-60" />
            <span className="text-[11px]">示例图未生成</span>
          </div>
        )}
        <div className="flex items-start justify-between gap-2">
          <p className="font-semibold">{direction.name}</p>
          {selected && <Badge className="bg-violet-500 text-white">已选择</Badge>}
        </div>
        {direction.concept && <p className="text-sm text-violet-600 dark:text-violet-300">{direction.concept}</p>}
        <p className="text-xs leading-5 text-muted-foreground">{direction.description}</p>
        <p className="rounded-md bg-violet-500/[0.07] px-2 py-1.5 text-[11px] leading-4">
          <span className="text-violet-600 dark:text-violet-300">固定风格提示词（选定后逐字拼接到 78 张每张提示词末尾）：</span>
          {direction.visualLanguage}
        </p>
        {direction.palette && (
          <p className="text-xs">
            <span className="text-muted-foreground">色调：</span>
            {direction.palette}
          </p>
        )}
        {direction.sampleCards.length > 0 && (
          <div className="space-y-1.5 rounded-lg bg-muted/40 p-2.5">
            <p className="text-[11px] font-medium text-muted-foreground">示例牌（示例图取自首张场景）</p>
            {direction.sampleCards.map((card) => (
              <p key={card.name} className="text-[11px] leading-4">
                <span className="font-medium">{card.name}</span>
                {card.scene && <span className="text-muted-foreground">：{card.scene}</span>}
              </p>
            ))}
          </div>
        )}
      </button>
      {(direction.worldview || direction.majorArcana || (direction.suitMapping?.length ?? 0) > 0) && (
        <Collapsible className="border-t">
          <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-2 text-xs text-muted-foreground hover:text-foreground">
            世界观与四花色设定
            <ChevronDown className="size-3.5" />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 px-4 pb-3 text-xs leading-5">
            {direction.worldview && (
              <p>
                <span className="text-muted-foreground">世界观：</span>
                {direction.worldview}
              </p>
            )}
            {direction.majorArcana && (
              <p>
                <span className="text-muted-foreground">大阿卡纳：</span>
                {direction.majorArcana}
              </p>
            )}
            {direction.suitMapping?.map((suit) => (
              <p key={suit.suit}>
                <span className="text-muted-foreground">{suit.suit}：</span>
                {suit.mapping}
              </p>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}
