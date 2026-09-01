"use client"

import { useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Plus,
  Replace,
  Trash2,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/workspace/spinner"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import {
  batchReplacePromptsAction,
  extractNumberedPromptsAction,
} from "@/server/actions/workspace"
import type { PromptCardRow, TemplateRow } from "@/lib/workspace/types"

interface NumberedPromptItem {
  cardIndex: number
  prompt: string
}

type DialogStep = "input" | "result" | "confirm"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  taskId: string | null
  selectedTemplate: TemplateRow | null
  cards: PromptCardRow[]
  selectedCardIds: Set<string>
  onCompleted: (cardCount: number) => void | Promise<void>
}

export function BatchReplacePromptDialog({
  open,
  onOpenChange,
  taskId,
  selectedTemplate,
  cards,
  selectedCardIds,
  onCompleted,
}: Props) {
  const [input, setInput] = useState("")
  const [items, setItems] = useState<NumberedPromptItem[]>([])
  const [extracting, setExtracting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [step, setStep] = useState<DialogStep>("input")

  const selectedIndexes = useMemo(
    () =>
      new Set(
        cards
          .filter((card) => selectedCardIds.has(card.id))
          .map((card) => card.cardIndex),
      ),
    [cards, selectedCardIds],
  )
  const allIndexes = useMemo(
    () => new Set(cards.map((card) => card.cardIndex)),
    [cards],
  )

  const duplicateIndexes = useMemo(() => {
    const counts = new Map<number, number>()
    items.forEach((item) =>
      counts.set(item.cardIndex, (counts.get(item.cardIndex) ?? 0) + 1),
    )
    return [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([index]) => index)
  }, [items])

  const emptyPromptIndexes = useMemo(
    () => items.filter((item) => !item.prompt.trim()).map((item) => item.cardIndex),
    [items],
  )
  const updateItems = useMemo(
    () => items.filter((item) => selectedIndexes.has(item.cardIndex)),
    [items, selectedIndexes],
  )
  const createItems = useMemo(
    () =>
      items.filter(
        (item) =>
          !selectedIndexes.has(item.cardIndex) &&
          !allIndexes.has(item.cardIndex),
      ),
    [items, selectedIndexes, allIndexes],
  )
  const conflictItems = useMemo(
    () =>
      items.filter(
        (item) =>
          !selectedIndexes.has(item.cardIndex) &&
          allIndexes.has(item.cardIndex),
      ),
    [items, selectedIndexes, allIndexes],
  )

  useEffect(() => {
    if (!open) {
      setInput("")
      setItems([])
      setExtracting(false)
      setSubmitting(false)
      setStep("input")
    }
  }, [open])

  const handleOpenChange = (value: boolean) => {
    if (!value && (submitting || extracting)) return
    onOpenChange(value)
  }

  const handleExtract = async () => {
    if (!taskId || !selectedTemplate) {
      toast.error("请先选择任务和提取提示词模板")
      return
    }
    if (!input.trim()) {
      toast.error("请输入需要提取的长段提示词")
      return
    }

    setExtracting(true)
    try {
      const res = await extractNumberedPromptsAction(taskId, {
        templateId: selectedTemplate.id,
        input,
      })
      if (!res.ok || !res.items) {
        throw new Error(res.error || "提取失败")
      }
      const nextItems = res.items.map((item) => ({
        cardIndex: Number(item.cardIndex),
        prompt: String(item.prompt || ""),
      }))
      if (nextItems.length === 0) {
        toast.error("未提取到任何提示词，请检查输入或模板")
        return
      }
      setItems(nextItems)
      setStep("result")
      toast.success(`已提取 ${nextItems.length} 条提示词`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提取失败")
    } finally {
      setExtracting(false)
    }
  }

  const updateItem = (index: number, patch: Partial<NumberedPromptItem>) => {
    setItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    )
  }

  const removeItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index))
  }

  const addItem = () => {
    setItems((prev) => [...prev, { cardIndex: 1, prompt: "" }])
  }

  const handleNext = () => {
    if (items.length === 0) {
      toast.error("请先添加提示词")
      return
    }
    if (duplicateIndexes.length > 0) {
      toast.error(`编号 #${duplicateIndexes.join("、#")} 重复`)
      return
    }
    if (emptyPromptIndexes.length > 0) {
      toast.error("存在空提示词，请先补充或删除")
      return
    }
    setStep("confirm")
  }

  const handleSubmit = async () => {
    if (!taskId) return
    setSubmitting(true)
    try {
      const res = await batchReplacePromptsAction(taskId, {
        selectedCardIds: [...selectedCardIds],
        items: items.map((item) => ({
          cardIndex: item.cardIndex,
          prompt: item.prompt,
        })),
      })
      if (!res.ok) {
        throw new Error("批量替换失败")
      }
      if (res.conflictCount > 0) {
        toast.warning(
          `已替换 ${res.updatedCount} 张，新建 ${res.createdCount} 张，${res.conflictCount} 个编号冲突已跳过`,
        )
      } else {
        toast.success(`已替换 ${res.updatedCount} 张，新建 ${res.createdCount} 张`)
      }
      await onCompleted(res.cardCount)
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "批量替换失败")
    } finally {
      setSubmitting(false)
    }
  }

  const busy = extracting || submitting

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="flex max-w-4xl max-h-[88vh] flex-col overflow-hidden"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Replace className="h-4 w-4" />
            批量替换提示词
          </DialogTitle>
        </DialogHeader>

        {step === "input" && (
          <div className="flex flex-col gap-4 overflow-y-auto pr-1">
            <div className="grid gap-2">
              <Label>长段提示词</Label>
              <Textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="粘贴包含数字序号的长段提示词"
                className="min-h-36 resize-none"
                disabled={extracting}
              />
              <div className="text-xs text-muted-foreground">
                当前模板：{selectedTemplate?.name || "未选择"}
              </div>
            </div>
            {extracting && <Spinner className="p-4" />}
          </div>
        )}

        {step === "result" && (
          <div className="space-y-4 overflow-hidden pr-1">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>提示词列表</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1"
                  onClick={addItem}
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加
                </Button>
              </div>
              <div className="max-h-[42vh] space-y-2 overflow-y-auto pr-1">
                {items.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                    暂无提示词，请点击添加后手动填写
                  </div>
                ) : (
                  items.map((item, index) => (
                    <div
                      key={index}
                      className="grid grid-cols-[110px_1fr_auto] gap-2 rounded-md border border-border bg-background p-2"
                    >
                      <Input
                        type="number"
                        min={1}
                        value={item.cardIndex}
                        onChange={(event) =>
                          updateItem(index, {
                            cardIndex: Number(event.target.value),
                          })
                        }
                        className="h-9"
                      />
                      <Textarea
                        value={item.prompt}
                        onChange={(event) =>
                          updateItem(index, { prompt: event.target.value })
                        }
                        className="min-h-16 resize-none text-sm"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeItem(index)}
                        className="h-9 gap-1 text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        删除
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {step === "confirm" && (
          <div className="space-y-4 overflow-y-auto pr-1 text-sm">
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <div className="text-xs text-muted-foreground">替换已选卡片</div>
                <div className="mt-1 text-xl font-semibold">
                  {updateItems.length}
                </div>
              </div>
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <div className="text-xs text-muted-foreground">确认后新建</div>
                <div className="mt-1 text-xl font-semibold">
                  {createItems.length}
                </div>
              </div>
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <div className="text-xs text-muted-foreground">冲突跳过</div>
                <div className="mt-1 text-xl font-semibold">
                  {conflictItems.length}
                </div>
              </div>
            </div>

            {createItems.length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                <div className="flex items-center gap-2 font-medium">
                  <AlertTriangle className="h-4 w-4" />
                  以下编号没有匹配已选卡片，确认后会新建
                </div>
                <div className="mt-2 text-xs">
                  #{createItems.map((item) => item.cardIndex).join("、#")}
                </div>
              </div>
            )}

            {conflictItems.length > 0 && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
                <div className="flex items-center gap-2 font-medium">
                  <AlertTriangle className="h-4 w-4" />
                  以下编号已存在但未选中，将跳过
                </div>
                <div className="mt-2 text-xs">
                  #{conflictItems.map((item) => item.cardIndex).join("、#")}
                </div>
              </div>
            )}

            {updateItems.length > 0 &&
              createItems.length === 0 &&
              conflictItems.length === 0 && (
                <div
                  className={cn(
                    "flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-emerald-900",
                    "dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200",
                  )}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  <span>将替换 {updateItems.length} 张已选卡片，无冲突。</span>
                </div>
              )}
          </div>
        )}

        <DialogFooter>
          {step === "input" && (
            <>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={extracting}
              >
                取消
              </Button>
              <Button
                onClick={handleExtract}
                disabled={extracting}
                className="gap-1.5"
              >
                {extracting ? "提取中..." : "提取"}
              </Button>
            </>
          )}
          {step === "result" && (
            <>
              <Button
                variant="outline"
                onClick={() => setStep("input")}
                className="gap-1.5"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                上一步
              </Button>
              <Button onClick={handleNext}>下一步</Button>
            </>
          )}
          {step === "confirm" && (
            <>
              <Button
                variant="outline"
                onClick={() => setStep("result")}
                disabled={submitting}
                className="gap-1.5"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                上一步
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={submitting}
                className="gap-1.5"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                {submitting ? "提交中..." : "确认替换"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
