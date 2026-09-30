"use client"

/**
 * 塔罗模板 · 阶段 2「内容方向」
 *
 * 世界观策划根据《设计简报》生成 3 个方向（名称 / 概念 / 世界观 / 大阿卡纳
 * 演绎 / 四花色映射 / 色调 / 视觉语言 / 3 张示例牌）。用户选中一个并可附
 * 补充意见后确认；不满意可附意见「换一批」。
 */
import { useState } from "react"
import { Check, ChevronDown, Loader2, RefreshCw, Sparkles } from "lucide-react"
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
}: {
  data: TemplateWorkspaceData
  busy: boolean
  runAction: RunTemplateAction
}) {
  const { run } = data
  const { regenerateDirections, selectTemplateDirection } = useWorkspaceActions()
  const directions = run.directions ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [feedback, setFeedback] = useState("")
  const generating = busy && run.pendingAction?.kind === "gen_directions"
  const selected = directions.find((direction) => direction.id === selectedId) ?? null

  return (
    <div className="space-y-4">
      {run.brief && (
        <Collapsible className="rounded-xl border bg-muted/20">
          <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium">
            已确认的《设计简报》
            <ChevronDown className="size-4 text-muted-foreground" />
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
            选择一个内容方向
          </CardTitle>
          <CardDescription>
            世界观策划根据你的简报构思了 3 个方向。选定后，整套 78 张牌、卡背和牌盒都会沿用这个世界观。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {generating || directions.length === 0 ? (
            <div className="grid gap-3 md:grid-cols-3" aria-live="polite">
              {[0, 1, 2].map((index) => (
                <div key={index} className="flex h-64 flex-col gap-3 rounded-xl border p-4">
                  <div className="h-5 w-24 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-full animate-pulse rounded bg-muted" />
                  <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
                  <div className="mt-auto flex items-center gap-2 text-xs text-muted-foreground">
                    {index === 0 && (
                      <>
                        <Loader2 className="size-3.5 animate-spin text-violet-500" />
                        {generating ? "世界观策划正在构思方向…" : "等待世界观策划生成方向"}
                      </>
                    )}
                  </div>
                </div>
              ))}
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
                      `已确认内容方向「${selected.name}」`,
                    )
                  }
                >
                  <Check className="size-4" />
                  确认方向，进入提示词设计
                </Button>
              </div>
            </div>
          )}

          {!generating && directions.length > 0 && (
            <div className="space-y-2 rounded-xl border border-dashed p-4">
              <label htmlFor="direction-feedback" className="text-sm font-medium">
                都不满意？告诉世界观策划要怎么调整
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
                      () => regenerateDirections({ runId: run.id, feedback: feedback.trim() || undefined }),
                      "世界观策划正在重新构思",
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
        <div className="flex items-start justify-between gap-2">
          <p className="font-semibold">{direction.name}</p>
          {selected && <Badge className="bg-violet-500 text-white">已选择</Badge>}
        </div>
        {direction.concept && <p className="text-sm text-violet-600 dark:text-violet-300">{direction.concept}</p>}
        <p className="text-xs leading-5 text-muted-foreground">{direction.description}</p>
        {direction.palette && (
          <p className="text-xs">
            <span className="text-muted-foreground">色调：</span>
            {direction.palette}
          </p>
        )}
        <p className="text-xs">
          <span className="text-muted-foreground">视觉语言：</span>
          {direction.visualLanguage}
        </p>
        {direction.sampleCards.length > 0 && (
          <div className="space-y-1.5 rounded-lg bg-muted/40 p-2.5">
            <p className="text-[11px] font-medium text-muted-foreground">示例牌</p>
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
