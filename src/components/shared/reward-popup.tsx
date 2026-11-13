"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { createPortal } from "react-dom"
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react"
import Confetti from "react-confetti"
import { useWindowSize } from "react-use"
import { Gift, PartyPopper } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { SlideToUnlock } from "@/components/ui/reward-card"
import { Button } from "@/components/ui/button"
import { BeamWrapper } from "@/components/create/beam-wrapper"
import { PlanBadge } from "@/components/shared/plan-badge"
import { formatDateTime } from "@/lib/datetime"
import { usePolling } from "@/hooks/use-polling"
import { cn } from "@/lib/utils"
import type { RewardNoticeDto, RewardNoticeType } from "@/lib/rewards/types"

/**
 * 奖励礼物弹窗（全局，挂 DashboardShell，覆盖全部登录路由组）
 *
 * 套餐开通/续约/周期发放、超管充值、管理员分配积分后，企业用户在此收到
 * 「滑动开礼物」卡片：解锁瞬间全屏撒花 + 渐变大数字滚动。
 *
 * 视觉：纯黑卡底（与主体 --background 同值 oklch(0.145 0 0)，恒定深色
 * 不随主题翻转、无色斑）+ BorderBeam 环形流光边框（BeamWrapper 复用）；
 * 文案「礼物惊喜体」：锁前统一「您有一份礼物」不透剧，解锁后类型标签
 * + 纯白 count-up 大数字 + 精简入账信息 + 祝语。
 *
 * 送达：挂载即拉一次 + 30s 轮询 GET /api/reward-notices（usePolling，
 * 页面隐藏自动跳过）；收下/ESC/点遮罩 = 已读（POST ack 推进游标），
 * 多张排队逐张弹出。超管/无企业接口恒空、渲染 null。
 */

/** 轮询间隔（在线用户约半分钟内看到新事件） */
const POLL_INTERVAL_MS = 30_000

/** 撒花色彩：极光色系（与卡片光斑同频） */
const CONFETTI_COLORS = ["#fbbf24", "#fb7185", "#a78bfa", "#ffffff"]

/** 解锁后 eyebrow 类型标签（锁前不透剧，统一「您有一份礼物」） */
const NOTICE_EYEBROW: Record<RewardNoticeType, string> = {
  plan_assigned: "企业套餐",
  plan_renewed: "企业套餐",
  plan_grant: "套餐积分",
  recharge: "企业积分",
  member_allocation: "积分到账",
}

/** 积分/套餐积分数额（套餐取 credits，充值/分配取 amount） */
function noticeCredits(n: RewardNoticeDto): number {
  if (n.type === "recharge" || n.type === "member_allocation") {
    return n.payload.amount ?? 0
  }
  return n.payload.credits ?? 0
}

/** 数字增长动画（kpi-tile 同款 useMotionValue + animate，尊重系统减弱动效） */
function CountUpCredits({ value }: { value: number }) {
  const reduced = useReducedMotion()
  const shown = useMotionValue(0)
  const text = useTransform(() => Math.round(shown.get()).toLocaleString("zh-CN"))
  useEffect(() => {
    const roll = animate(
      shown,
      value,
      reduced ? { duration: 0 } : { duration: 1.4, ease: "easeOut" },
    )
    return () => roll.stop()
  }, [reduced, shown, value])
  return <motion.span className="tabular-nums">{text}</motion.span>
}

/** eyebrow 类型小标行（礼物图标 + 类型文字） */
function NoticeEyebrow({ type }: { type: RewardNoticeType }) {
  return (
    <p className="flex items-center justify-center gap-1.5 text-xs font-medium tracking-[0.35em] text-white/50">
      <Gift aria-hidden className="size-3.5" />
      {NOTICE_EYEBROW[type]}
    </p>
  )
}

/** 锁前内容：磨砂礼物图标 + 惊喜框文案（不透剧；卡面纯黑无色斑） */
function LockedFace() {
  return (
    <div className="relative text-center">
      <div className="relative mt-2 mb-4 flex h-20 w-20 items-center justify-center self-center mx-auto rounded-full bg-white/10 ring-1 ring-white/15">
        <Gift className="h-9 w-9 text-white" />
      </div>

      <h2 className="font-heading mt-2 text-2xl font-bold tracking-tight text-white">
        您有一份礼物
      </h2>
      <p className="mt-2 text-sm text-white/60">滑动拆开看看</p>
    </div>
  )
}

/** 解锁后内容：类型标签 + 套餐徽章 + 纯白大数字 + 精简入账信息 + 祝语 */
function UnlockedFace({
  notice,
  onDone,
}: {
  notice: RewardNoticeDto
  onDone: () => void
}) {
  const credits = noticeCredits(notice)
  const p = notice.payload
  const isPlan = notice.type.startsWith("plan_")
  return (
    <div className="relative text-center">
      <NoticeEyebrow type={notice.type} />

      {p.planName ? (
        <div className="relative mt-3 flex justify-center">
          <PlanBadge
            iconKey={p.planIconKey}
            color={p.planColor}
            name={p.planName}
            size="md"
          />
        </div>
      ) : null}

      {credits > 0 ? (
        <div className="relative mt-5 flex items-end justify-center gap-1.5">
          <span className="font-heading text-5xl leading-none font-bold text-white">
            +<CountUpCredits value={credits} />
          </span>
          <span className="mb-1 text-sm font-medium text-white/60">积分</span>
        </div>
      ) : null}

      <ul className="relative mt-5 space-y-1 text-sm text-white/60">
        <li>
          {notice.type === "member_allocation"
            ? "已存入个人积分配额"
            : "已存入企业积分池"}
        </li>
        {isPlan && p.expiresAt && notice.type !== "plan_grant" ? (
          <li>有效期至 {formatDateTime(p.expiresAt)}</li>
        ) : null}
        {notice.type === "plan_grant" && p.periodEnd ? (
          <li>本期周期至 {formatDateTime(p.periodEnd)}</li>
        ) : null}
      </ul>

      <p className="relative mt-3 text-xs text-white/50">祝创作愉快 ✦</p>

      <Button
        className="mt-5 w-full bg-white font-semibold text-neutral-900 shadow-lg hover:bg-white/90"
        onClick={onDone}
      >
        <PartyPopper data-slot="icon" />
        收下礼物
      </Button>
    </div>
  )
}

/** 单张礼物卡（解锁态本地隔离，key=notice.id 换卡即重置） */
function RewardCardItem({
  notice,
  onDone,
}: {
  notice: RewardNoticeDto
  onDone: () => void
}) {
  const [unlocked, setUnlocked] = useState(false)
  const reduced = useReducedMotion()
  const { width, height } = useWindowSize()

  return (
    <>
      {unlocked && !reduced && typeof document !== "undefined"
        ? // portal 到 body：DialogContent 弹层带居中 transform，是 fixed 后代
          // 的包含块，canvas 留在弹层内会被钳在卡片盒里（撒花只盖住卡片）
          createPortal(
            <Confetti
              width={width}
              height={height}
              recycle={false}
              numberOfPieces={450}
              gravity={0.13}
              wind={0.015}
              colors={CONFETTI_COLORS}
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 60,
                pointerEvents: "none",
              }}
            />,
            document.body,
          )
        : null}
      <BeamWrapper
        size="md"
        colorVariant="colorful"
        theme="dark"
        borderRadius={16}
        className="w-full max-w-xs"
      >
        <SlideToUnlock
          onUnlock={() => setUnlocked(true)}
          sliderText="滑动拆开礼物"
          unlockedContent={<UnlockedFace notice={notice} onDone={onDone} />}
          className="rounded-2xl border-white/10 bg-[oklch(0.145_0_0)] shadow-2xl"
          trackClassName="border border-white/10 bg-white/10 shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)]"
          handleClassName="bg-white shadow-[0_4px_16px_-2px_rgba(255,255,255,0.4)] ring-1 ring-white/60 [&>svg]:text-neutral-900"
        >
          <LockedFace />
        </SlideToUnlock>
      </BeamWrapper>
    </>
  )
}

export function RewardPopup() {
  const router = useRouter()
  const [queue, setQueue] = useState<RewardNoticeDto[]>([])
  // 本会话已收下的 id：ack 请求在途时防止下一轮轮询把同一张卡又塞回来
  const dismissedRef = useRef<Set<string>>(new Set())

  const fetchPending = useCallback(async () => {
    try {
      const res = await fetch("/api/reward-notices", { cache: "no-store" })
      if (!res.ok) return
      const data = (await res.json()) as { items: RewardNoticeDto[] }
      setQueue((prev) => {
        const seen = new Set(prev.map((n) => n.id))
        const fresh = data.items.filter(
          (n) => !seen.has(n.id) && !dismissedRef.current.has(n.id),
        )
        return fresh.length ? [...prev, ...fresh] : prev
      })
    } catch {
      // 网络抖动静默，下一轮轮询自愈
    }
  }, [])

  // usePolling 不做首拍：挂载先拉一次
  useEffect(() => {
    void fetchPending()
  }, [fetchPending])
  usePolling(true, POLL_INTERVAL_MS, fetchPending)

  const dismissCurrent = useCallback(() => {
    const head = queue[0]
    if (!head) return
    dismissedRef.current.add(head.id)
    const rest = queue.slice(1)
    setQueue(rest)
    // ack 失败不打扰用户：本会话已靠 dismissedRef 去重，下次登录会重弹
    void fetch("/api/reward-notices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: head.id }),
    }).catch(() => {})
    // 队列清空时刷新壳层数据（侧边栏余额/套餐勋章同步最新值）
    if (rest.length === 0) router.refresh()
  }, [queue, router])

  const current = queue[0] ?? null

  return (
    <Dialog
      open={!!current}
      onOpenChange={(open) => {
        if (!open) dismissCurrent()
      }}
    >
      <DialogContent
        className={cn(
          "gap-0 overflow-visible border-none bg-transparent p-0 ring-0 shadow-none sm:max-w-xs",
        )}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">奖励通知</DialogTitle>
        {current ? (
          <RewardCardItem key={current.id} notice={current} onDone={dismissCurrent} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
