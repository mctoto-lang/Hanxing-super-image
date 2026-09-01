"use client"

import { RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { Textarea } from "@/components/ui/textarea"
import type { SuiteCard } from "@/lib/product/types"

/**
 * 套图卡片确认阶段：AI 生成的画面提示词以卡片呈现，
 * 用户可修改文本 / 删除卡片 / 单卡重新生成，确认后才进入生图。
 */
export function SuiteCardReview({
  cards,
  unitCost,
  submitting,
  regeneratingIndex,
  onCardsChange,
  onRegen,
  onBack,
  onConfirm,
}: {
  cards: SuiteCard[]
  /** 单张图积分（预估用） */
  unitCost: number
  submitting: boolean
  /** 正在重新生成的卡片下标（null=无） */
  regeneratingIndex: number | null
  onCardsChange: (next: SuiteCard[]) => void
  onRegen: (index: number) => void
  /** 返回配置阶段（丢弃卡片） */
  onBack: () => void
  onConfirm: () => void
}) {
  const setPrompt = (i: number, prompt: string) => {
    onCardsChange(cards.map((c, idx) => (idx === i ? { ...c, prompt } : c)))
  }

  const removeCard = (i: number) => {
    onCardsChange(cards.filter((_, idx) => idx !== i))
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">确认画面提示词</p>
        <span className="text-xs text-muted-foreground">
          可修改提示词或删除卡片，确认后开始生图
        </span>
      </div>

      {cards.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          卡片已全部删除，请返回修改结构或重新生成
        </div>
      ) : (
        <div className="space-y-2">
          {cards.map((card, i) => (
            <div key={i} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium">
                  {i + 1}. {card.directionName}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="重新生成此卡提示词"
                    disabled={submitting || regeneratingIndex !== null}
                    onClick={() => onRegen(i)}
                  >
                    {regeneratingIndex === i ? (
                      <MorphingInfinity className="size-3.5" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="删除此卡片"
                    disabled={submitting}
                    onClick={() => removeCard(i)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>

              <Textarea
                value={card.prompt}
                onChange={(e) => setPrompt(i, e.target.value)}
                rows={5}
                disabled={submitting}
                className="text-xs leading-relaxed"
                placeholder="画面提示词（可编辑）"
              />
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between border-t pt-3">
        <div className="text-sm text-muted-foreground">
          共 <span className="font-medium tabular-nums text-foreground">
            {cards.length}
          </span>{" "}
          张 · 预计{" "}
          <span className="font-medium tabular-nums text-foreground">
            {cards.length * unitCost}
          </span>{" "}
          积分
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onBack} disabled={submitting}>
            返回修改
          </Button>
          <Button
            onClick={onConfirm}
            disabled={submitting || cards.length === 0 || regeneratingIndex !== null}
          >
            {submitting && <MorphingInfinity className="mr-1 size-4" />}
            确认生成
          </Button>
        </div>
      </div>
    </div>
  )
}
