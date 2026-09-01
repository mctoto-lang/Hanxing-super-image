"use client"

import { useEffect, useState } from "react"
import {
  Flame,
  Gift,
  Megaphone,
  PartyPopper,
  Rocket,
  Sparkles,
  TicketPercent,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { Banner } from "@/components/ui/banner"
import { Button, buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { DisplayBanner } from "@/server/actions/platform-banners"

/**
 * 广告横幅（展示端）
 *
 * - 挂载于 DashboardShell（所有登录后页面），营销页/登录页不展示
 * - 数据由服务端随机取一条传入（多条轮换）；倒计时到期整条下线
 * - 关闭记忆：localStorage 按 id+内容指纹记录，横幅被超管编辑后重新出现
 * - 初始渲染返回 null（SSR 不输出），useEffect 确认未关闭后才显示，
 *   避免 hydration 不匹配与关闭横幅的闪现
 */

const ICON_MAP: Record<string, LucideIcon> = {
  megaphone: Megaphone,
  "ticket-percent": TicketPercent,
  sparkles: Sparkles,
  gift: Gift,
  zap: Zap,
  flame: Flame,
  "party-popper": PartyPopper,
  rocket: Rocket,
}

interface TimeLeft {
  days: number
  hours: number
  minutes: number
  seconds: number
}

function calcTimeLeft(endsAt: number, now: number): TimeLeft | null {
  const difference = endsAt - now
  if (difference <= 0) return null
  return {
    days: Math.floor(difference / (1000 * 60 * 60 * 24)),
    hours: Math.floor((difference % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
    minutes: Math.floor((difference % (1000 * 60 * 60)) / (1000 * 60)),
    seconds: Math.floor((difference % (1000 * 60)) / 1000),
  }
}

function pad2(n: number) {
  return n.toString().padStart(2, "0")
}

function CountdownBlock({ timeLeft }: { timeLeft: TimeLeft }) {
  return (
    <div className="flex items-center divide-x divide-primary-foreground rounded-lg bg-primary/15 text-sm tabular-nums">
      {timeLeft.days > 0 && (
        <span className="flex h-8 items-center justify-center p-2">
          {timeLeft.days}
          <span className="text-muted-foreground">d</span>
        </span>
      )}
      <span className="flex h-8 items-center justify-center p-2">
        {pad2(timeLeft.hours)}
        <span className="text-muted-foreground">h</span>
      </span>
      <span className="flex h-8 items-center justify-center p-2">
        {pad2(timeLeft.minutes)}
        <span className="text-muted-foreground">m</span>
      </span>
      <span className="flex h-8 items-center justify-center p-2">
        {pad2(timeLeft.seconds)}
        <span className="text-muted-foreground">s</span>
      </span>
    </div>
  )
}

export function AdBanner({ banner }: { banner: DisplayBanner | null }) {
  const [mounted, setMounted] = useState(false)
  const [closed, setClosed] = useState(false)
  const [timeLeft, setTimeLeft] = useState<TimeLeft | null | "no-countdown">(
    "no-countdown",
  )

  const storageKey = banner
    ? `ad-banner-closed:${banner.id}:${banner.revision}`
    : ""

  useEffect(() => {
    setMounted(true)
    if (!banner) return
    setClosed(localStorage.getItem(storageKey) === "1")

    if (!banner.countdownEndsAt) {
      setTimeLeft("no-countdown")
      return
    }
    const endsAt = new Date(banner.countdownEndsAt).getTime()
    setTimeLeft(calcTimeLeft(endsAt, Date.now()))
    const timer = setInterval(
      () => setTimeLeft(calcTimeLeft(endsAt, Date.now())),
      1000,
    )
    return () => clearInterval(timer)
  }, [banner, storageKey])

  if (!banner || !mounted || closed) return null
  // 倒计时进行中但还没算出剩余时间，或已到期：先不渲染，等 effect 对齐
  if (timeLeft === null) return null

  const Icon = ICON_MAP[banner.icon] ?? Megaphone
  const hasCountdown = timeLeft !== "no-countdown"

  const close = () => {
    localStorage.setItem(storageKey, "1")
    setClosed(true)
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-40 flex justify-center">
      <Banner
        variant="muted"
        size="lg"
        rounded="default"
        className="dark pointer-events-auto mt-2 w-[min(48rem,calc(100%-2rem))] border text-foreground shadow-lg"
      >
        <div className="flex w-full gap-2 md:items-center">
        <div className="flex grow gap-3 md:items-center">
          <div
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 max-md:mt-0.5"
            aria-hidden="true"
          >
            <Icon className="opacity-80" size={16} strokeWidth={2} />
          </div>
          <div className="flex grow flex-col justify-between gap-3 md:flex-row md:items-center">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">{banner.title}</p>
              <p className="text-sm text-muted-foreground">{banner.content}</p>
            </div>
            {(hasCountdown || banner.linkUrl) && (
              <div className="flex gap-3 max-md:flex-wrap">
                {hasCountdown && <CountdownBlock timeLeft={timeLeft} />}
                {banner.linkUrl && (
                  <a
                    href={banner.linkUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className={cn(buttonVariants({ size: "sm" }), "text-sm")}
                  >
                    {banner.linkLabel}
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          className="group -my-1.5 -me-2 size-8 shrink-0 p-0 hover:bg-transparent"
          onClick={close}
          aria-label="关闭横幅"
        >
          <X
            size={16}
            strokeWidth={2}
            className="opacity-60 transition-opacity group-hover:opacity-100"
            aria-hidden="true"
          />
        </Button>
        </div>
      </Banner>
    </div>
  )
}
