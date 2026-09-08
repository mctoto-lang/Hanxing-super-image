"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Plus } from "lucide-react"
import { FlipCard } from "./flip-card"
import { Skeleton } from "@/components/ui/skeleton"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import {
  GRID_COLUMNS,
  INITIAL_VISIBLE_COUNT,
  VISIBLE_STEP,
  getBottomSkeletonCount,
  getBottomSkeletonIndexes,
  getNextVisibleCountOnDataChange,
  shouldShowBottomSkeletons,
} from "@/lib/workspace/helpers"
import type {
  CardImageRow,
  ImageModelRow,
  PromptCardRow,
  TemplateRow,
} from "@/lib/workspace/types"

const EMPTY_SET = new Set<string>()
const EMPTY_IMAGES: CardImageRow[] = []

interface CardGridProps {
  taskId: string
  cards: PromptCardRow[]
  cardImagesMap: Map<string, CardImageRow[]>
  /** 卡片滚动容器（哨兵预加载的 IntersectionObserver root）；
   *  不传则退化为视口 root（嵌套滚动容器下预取余量会被裁剪归零） */
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>
  batchMode: boolean
  selectedCardIds: Set<string>
  flipAllToImage: boolean
  /** 工具面板打开：点击卡片联动设为面板活动卡片 */
  toolPanelMode?: boolean
  activeCardId?: string | null
  onCardActivate?: (cardId: string) => void
  selectedDeepenTemplate: TemplateRow | null
  selectedRegenTemplate: TemplateRow | null
  selectedTranslateTemplate: TemplateRow | null
  selectedImageModel: ImageModelRow | null
  selectedSize: string | null
  onToggleSelect: (cardId: string) => void
  onCardUpdated: (card: PromptCardRow) => void
  onCardDeleted?: (cardId: string) => void
  onAddCard: () => Promise<PromptCardRow | null>
  onCardGeneratingImage?: (cardId: string, generating: boolean) => void
  batchDeepeningCardIds?: Set<string>
  batchRegeneratingCardIds?: Set<string>
  batchTranslatingCardIds?: Set<string>
  batchGeneratingImageCardIds?: Set<string>
}

function CardSkeleton({ indexLabel }: { indexLabel?: number }) {
  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-border/60 bg-card/60"
      style={{ aspectRatio: "3 / 5" }}
    >
      <Skeleton className="absolute inset-0 rounded-2xl" />
      {typeof indexLabel === "number" && (
        <div className="absolute bottom-2.5 left-2.5 flex gap-1">
          <span className="animate-pulse select-none rounded-full bg-black/12 px-2 py-0.5 text-[10px] font-medium text-foreground/28">
            #{indexLabel}
          </span>
        </div>
      )}
    </div>
  )
}

export const CardGrid = memo(function CardGrid({
  taskId,
  cards,
  cardImagesMap,
  scrollContainerRef,
  batchMode,
  selectedCardIds,
  flipAllToImage,
  toolPanelMode = false,
  activeCardId = null,
  onCardActivate,
  selectedDeepenTemplate,
  selectedRegenTemplate,
  selectedTranslateTemplate,
  selectedImageModel,
  selectedSize,
  onToggleSelect,
  onCardUpdated,
  onCardDeleted,
  onAddCard,
  onCardGeneratingImage,
  batchDeepeningCardIds = EMPTY_SET,
  batchRegeneratingCardIds = EMPTY_SET,
  batchTranslatingCardIds = EMPTY_SET,
  batchGeneratingImageCardIds = EMPTY_SET,
}: CardGridProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const addTileRef = useRef<HTMLDivElement | null>(null)
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT)
  const [skeletonCount, setSkeletonCount] = useState(GRID_COLUMNS)
  const previousTaskIdRef = useRef<string>(taskId)
  const [addingCard, setAddingCard] = useState(false)

  // 追加检测：同一任务末尾出现新卡片（点击「添加卡片」）时的末尾卡片 id 快照
  const previousTailRef = useRef<{
    taskId: string
    lastCardId: string | null
  }>({ taskId, lastCardId: cards.at(-1)?.id ?? null })

  // taskId 变化时重置可见数量；否则按数据变化调整
  useEffect(() => {
    if (previousTaskIdRef.current !== taskId) {
      previousTaskIdRef.current = taskId
      setVisibleCount(INITIAL_VISIBLE_COUNT)
      return
    }
    setVisibleCount((prev) => getNextVisibleCountOnDataChange(prev, cards.length))
  }, [taskId, cards.length])

  // 同一任务末尾追加新卡片（点击「添加卡片」）：展开虚拟列表并滚动定位到新卡
  // （须声明在上面的通用 effect 之后，避免被其覆盖）
  useEffect(() => {
    const previous = previousTailRef.current
    const lastCardId = cards.at(-1)?.id ?? null
    if (
      previous.taskId === taskId &&
      previous.lastCardId !== null &&
      lastCardId !== null &&
      previous.lastCardId !== lastCardId
    ) {
      setVisibleCount(cards.length)
      requestAnimationFrame(() => {
        addTileRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        })
      })
    }
    previousTailRef.current = { taskId, lastCardId }
  }, [taskId, cards])

  // 根据容器宽度调整骨架屏数量
  useEffect(() => {
    const updateSkeletonCount = () => {
      if (typeof window === "undefined") return
      const width = window.innerWidth

      if (width < 640) {
        setSkeletonCount(1)
        return
      }
      if (width < 1024) {
        setSkeletonCount(2)
        return
      }
      if (width < 1280) {
        setSkeletonCount(3)
        return
      }
      setSkeletonCount(GRID_COLUMNS)
    }

    updateSkeletonCount()
    window.addEventListener("resize", updateSkeletonCount)
    return () => window.removeEventListener("resize", updateSkeletonCount)
  }, [])

  const hasMore = visibleCount < cards.length
  const visibleCards = useMemo(
    () => cards.slice(0, visibleCount),
    [cards, visibleCount],
  )
  const shouldShowLoadingSkeletons = shouldShowBottomSkeletons(
    visibleCount,
    cards.length,
  )
  const fullSkeletonCount = getBottomSkeletonCount(visibleCount, cards.length)
  const bottomSkeletonCount = shouldShowLoadingSkeletons
    ? Math.min(fullSkeletonCount, skeletonCount)
    : 0
  const bottomSkeletonIndexes = useMemo(
    () =>
      getBottomSkeletonIndexes(visibleCount, cards.length).slice(
        0,
        bottomSkeletonCount,
      ),
    [visibleCount, cards.length, bottomSkeletonCount],
  )

  const loadMore = useCallback(() => {
    setVisibleCount((prev) => Math.min(prev + VISIBLE_STEP, cards.length))
  }, [cards.length])

  useEffect(() => {
    if (!hasMore) return
    const element = sentinelRef.current
    if (!element) return

    // root 必须指向真实的嵌套滚动容器：用默认视口 root 时，哨兵在容器内
    // 被容器边缘裁剪，rootMargin 预取余量失效（表现为必须拉到底才加载）
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) loadMore()
      },
      {
        root: scrollContainerRef?.current ?? null,
        rootMargin: "1200px 0px",
      },
    )

    observer.observe(element)
    return () => observer.disconnect()
  }, [hasMore, loadMore, scrollContainerRef])

  const handleAddCard = useCallback(async () => {
    if (addingCard) return
    setAddingCard(true)
    try {
      await onAddCard()
    } catch {
      // 错误由父组件处理
    } finally {
      setAddingCard(false)
    }
  }, [addingCard, onAddCard])

  return (
    <>
      <div
        className="grid gap-5 p-5"
        style={{ gridTemplateColumns: `repeat(${GRID_COLUMNS}, 1fr)` }}
      >
        {visibleCards.map((card) => (
          <FlipCard
            key={card.id}
            card={card}
            images={cardImagesMap.get(card.id) || EMPTY_IMAGES}
            batchMode={batchMode}
            isSelected={selectedCardIds.has(card.id)}
            flipAllToImage={flipAllToImage}
            panelMode={toolPanelMode}
            isActiveCard={toolPanelMode && activeCardId === card.id}
            onCardActivate={onCardActivate}
            selectedDeepenTemplate={selectedDeepenTemplate}
            selectedRegenTemplate={selectedRegenTemplate}
            selectedTranslateTemplate={selectedTranslateTemplate}
            selectedImageModel={selectedImageModel}
            selectedSize={selectedSize}
                onToggleSelect={onToggleSelect}
                onCardUpdated={onCardUpdated}
                onCardDeleted={onCardDeleted}
                onCardGeneratingImage={onCardGeneratingImage}
            batchDeepening={batchDeepeningCardIds.has(card.id)}
            batchRegenerating={batchRegeneratingCardIds.has(card.id)}
            batchTranslating={batchTranslatingCardIds.has(card.id)}
            batchGeneratingImage={batchGeneratingImageCardIds.has(card.id)}
          />
        ))}
        {bottomSkeletonIndexes.map((indexLabel, index) => (
          <CardSkeleton key={`bottom-skeleton-${index}`} indexLabel={indexLabel} />
        ))}
        {/* 添加卡片：点击直接创建空白卡片（自动翻到提示词面编辑） */}
        <div
          ref={addTileRef}
          className="group relative flex cursor-pointer items-center justify-center rounded-2xl border-2 border-dashed border-border bg-muted/30 transition-all duration-200 hover:border-primary/40 hover:bg-muted/50"
          style={{ aspectRatio: "3 / 5" }}
          role="button"
          aria-label="添加空白卡片"
          onClick={() => void handleAddCard()}
        >
          {addingCard ? (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <MorphingInfinity className="h-7 w-7" />
              <span className="text-xs">添加中</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-muted-foreground transition-colors group-hover:text-primary">
              <Plus className="h-8 w-8" />
              <span className="text-xs">添加卡片</span>
            </div>
          )}
        </div>
      </div>
      {hasMore && (
        <div className="px-5 pb-5">
          <div ref={sentinelRef} className="-mt-5 h-1 w-full" />
        </div>
      )}
    </>
  )
})
