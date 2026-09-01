"use client"

import * as React from "react"
import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { AtSign, ArrowUp } from "lucide-react"
import { BeamWrapper } from "@/components/create/beam-wrapper"
import { CreatePromptInput } from "@/components/create/create-prompt-input"
import {
  TaskDetailCard,
  type TaskDetail,
  type EditTaskPayload,
} from "@/components/create/task-detail-card"
import type { CreateModel } from "@/components/create/types"

/**
 * 右侧会话详情（自由创作页 §6 v6）
 *
 * - 顶部无标题栏：会话通过左侧列表高亮识别；整页不滚动，
 *   仅任务列表滚动容器可上下滑动。
 * - 中间滚动区：按日期分组（今天 / 昨天 / 前天 / 具体日期）的任务消息列表，
 *   正序最新在下；日期标签大号加粗；内容居中，宽度 = calc(50% + 384px)
 *   （在任意视口下把 max-w-3xl(768px) 时代的左右留白精确减半），与展开输入框同宽。
 * - 底部：悬浮生图输入框（与卡片同宽）；上滑后收起为紧凑悬浮条
 *   （max-w-md，常开彩色边框光效）；滚回底部或点击紧凑条展开（带过渡动画）。
 * - 滚动区底部留白恒为「展开态输入框实测高度 + 24px」（收起期间不缩小），
 *   即滚到最底 = 最后一张卡片按钮下方恰好容纳一个完整展开生图框；
 *   留白不随展开/收起跳变，从根源上消除滚动触底的展开↔收起循环闪烁。
 * - 收纳触发阈值 = 展开态高度 + 24px + 24px：卡片按钮贴近输入框顶部时才收起。
 * - 有 pending task 时 4s 轮询 router.refresh()。
 */

/** 日期分组标签：今天 / 昨天 / 前天 / 2026年8月19日 */
function formatDayLabel(date: Date): string {
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diffDays = Math.round(
    (startOfDay(new Date()) - startOfDay(date)) / 86_400_000,
  )
  if (diffDays === 0) return "今天"
  if (diffDays === 1) return "昨天"
  if (diffDays === 2) return "前天"
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

export function ConversationDetail({
  conversationId,
  tasks,
  models,
  userCredits,
  enterpriseCredits,
}: {
  conversationId: string
  tasks: TaskDetail[]
  models: CreateModel[]
  userCredits: number
  enterpriseCredits: number
}) {
  const router = useRouter()
  const scrollRef = useRef<HTMLDivElement>(null)
  // 底部悬浮容器（展开输入框 / 收起紧凑条），用于测量实际高度
  const footerRef = useRef<HTMLDivElement>(null)
  // 展开态容器实测高度（含 p-4）：驱动底部留白与收纳阈值；
  // 收起期间保持不缩小，避免留白跳变引发的展开↔收起循环闪烁
  const [expandedFooterH, setExpandedFooterH] = useState(0)

  // 输入框展开状态：滚回底部自动展开；上滑收起；点击紧凑条手动展开
  const [expanded, setExpanded] = useState(true)
  // 预填内容（重新编辑），nonce 变化触发 CreatePromptInput 应用
  const [prefill, setPrefill] = useState<{
    text: string
    referenceImages?: string[]
    nonce: number
  } | null>(null)
  const [focusNonce, setFocusNonce] = useState(0)

  // 是否有待处理任务（轮询用）
  const hasPending = tasks.some(
    (t) => t.status === "queued" || t.status === "processing",
  )

  useEffect(() => {
    if (!hasPending) return
    const timer = setInterval(() => router.refresh(), 4000)
    return () => clearInterval(timer)
  }, [hasPending, router])

  // 收纳触发阈值：展开态高度 + 24px 间隔 + 24px 余量。
  // 即卡片按钮上滑到距输入框顶部约 24px 内保持展开，离开则收起。
  const nearBottomThreshold = expandedFooterH ? expandedFooterH + 24 + 24 : 80

  // 滚动监听：离开底部（超过阈值）→ 收起；回到阈值内 → 展开
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const near =
        el.scrollHeight - el.scrollTop - el.clientHeight < nearBottomThreshold
      setExpanded(near)
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [nearBottomThreshold])

  // ResizeObserver 实时测量悬浮容器高度（输入框随参考图/多行提示词增删会变化）。
  // 展开/收起的判定不依赖 React 状态时序（RO 回调在布局后、effect 前执行，
  // 读 state/ref 都可能过期），而是直接查 DOM：展开态渲染 textarea、收起态
  // 渲染紧凑条按钮——布局真相即当前分支：
  //   展开态 → 实时跟随（含合法收缩，如删参考图/提示词变短）
  //   收起态 → 只增不减（收起条必矮于展开框，变高只可能是展开重挂载帧；
  //            若不记录，留白停留在旧值 → 输入框遮挡最后一张卡片且无法滚出）
  useEffect(() => {
    const el = footerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = (entry.target as HTMLElement).offsetHeight
        const expandedNow = el.querySelector("textarea") !== null
        setExpandedFooterH((prev) => (expandedNow ? h : Math.max(prev, h)))
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  function scrollToBottom(smooth = true) {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" })
  }

  // 新任务到来时自动滚动到底部并展开（对话流式体验）
  useEffect(() => {
    scrollToBottom(false)
    setExpanded(true)
  }, [tasks.length])

  /** 点击紧凑条：展开 + 滚到底部 + 聚焦输入框 */
  function handleCollapsedClick() {
    setExpanded(true)
    scrollToBottom()
    setFocusNonce((n) => n + 1)
  }

  /** 「重新编辑」：填入提示词 + 参考图并展开输入框 */
  function handleEditTask(payload: EditTaskPayload) {
    setPrefill({
      text: payload.prompt,
      referenceImages: payload.referenceImages,
      nonce: Date.now(),
    })
    setExpanded(true)
    scrollToBottom()
    setFocusNonce((n) => n + 1)
  }

  // 日期分组：与上一条不同天才渲染分组标签
  let lastLabel = ""

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* 中间滚动区：按日期分组的任务列表（顶部无标题栏，会话通过左侧列表高亮识别）。
          整页不滚动，仅此容器可上下滑动。
          底部留白恒为「展开态输入框实测高度 + 24px」：滚到最底 = 最后一张卡片
          按钮下方恰好容纳一个完整展开生图框；留白不随展开/收起跳变（防闪烁） */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4"
        style={{ paddingBottom: expandedFooterH ? expandedFooterH + 24 : 48 }}
      >
        {/* 内容容器：居中，宽度 = calc(50% + 384px)（原 max-w-3xl 时代左右留白精确减半） */}
        <div
          className="mx-auto w-full space-y-1"
          style={{ maxWidth: "calc(50% + 384px)" }}
        >
          {tasks.length === 0 ? (
            <div className="mt-12 flex flex-col items-center gap-2 text-center">
              <p className="text-sm text-muted-foreground">
                在下方输入提示词，开始在这个会话中生图
              </p>
            </div>
          ) : (
            tasks.map((t) => {
              const label = formatDayLabel(new Date(t.createdAt))
              const showLabel = label !== lastLabel
              lastLabel = label
              return (
                <React.Fragment key={t.id}>
                  {showLabel && (
                    <p className="px-1 pb-2 pt-5 text-lg font-semibold text-foreground first:pt-0">
                      {label}
                    </p>
                  )}
                  <TaskDetailCard
                    task={t}
                    conversationId={conversationId}
                    onEditTask={handleEditTask}
                  />
                </React.Fragment>
              )
            })
          )}
        </div>
      </div>

      {/* 底部悬浮生图框：上滑收起为紧凑条（展开态与任务卡片同宽）。
          z-50：盖住任务卡片的下拉菜单（z-40），菜单不悬浮在输入框上方；
          删除确认弹窗同为 z-50 且 Portal 在 DOM 更靠后，仍在最上层 */}
      <div
        ref={footerRef}
        className="pointer-events-none absolute bottom-0 left-0 right-0 z-50 p-4"
      >
        {expanded ? (
          <div
            className="pointer-events-auto mx-auto w-full animate-in fade-in zoom-in-95 duration-200"
            style={{ maxWidth: "calc(50% + 384px)" }}
          >
            <CreatePromptInput
              models={models}
              userCredits={userCredits}
              enterpriseCredits={enterpriseCredits}
              conversationId={conversationId}
              prefill={prefill}
              focusNonce={focusNonce}
            />
          </div>
        ) : (
          <div className="pointer-events-auto mx-auto w-full max-w-md animate-in fade-in zoom-in-95 duration-200">
            {/* 收起态同样带边框光效（常开，与展开态同款 colorful） */}
            <BeamWrapper active colorVariant="colorful" size="md" borderRadius={22}>
              <button
                type="button"
                onClick={handleCollapsedClick}
                className="flex h-11 w-full items-center gap-2 rounded-full border bg-card/95 px-3 shadow-lg backdrop-blur-sm transition-colors hover:bg-accent/50"
              >
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground">
                  <AtSign className="size-4" />
                </span>
                <span className="flex-1 truncate text-left text-sm text-muted-foreground">
                  继续输入提示词，@ 可上传参考图
                </span>
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <ArrowUp className="size-4" />
                </span>
              </button>
            </BeamWrapper>
          </div>
        )}
      </div>
    </div>
  )
}
