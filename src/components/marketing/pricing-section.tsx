"use client"

import { useState } from "react"
import { CheckCircleIcon, StarIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * 订阅套餐区块（marketing 落地页「订阅套餐」锚点）
 *
 * 改写自 Launch UI pricing 模板：原版依赖 framer-motion（月/年切换滑块的
 * layoutId 动画、BorderTrail 的 offsetDistance 补间），这里全部换成纯 CSS——
 * 滑块用 transform transition，流光用 globals.css 里的 @keyframes borderTrail
 * 驱动 offset-distance。配色不用 shadcn token，直接对齐落地页的深色白系
 * （bg-neutral-950 + white/xx），避免营销页未挂 .dark 时 token 失真。
 */

type Frequency = "monthly" | "yearly"

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: "monthly", label: "月付" },
  { value: "yearly", label: "年付" },
]

interface PlanFeature {
  text: string
  tooltip?: string
}

interface Plan {
  name: string
  info: string
  /** 年付价为月付 ×12 打 88 折（与折扣徽章的计算保持一致） */
  price: { monthly: number; yearly: number }
  features: PlanFeature[]
  btn: { text: string; href: string }
  highlighted?: boolean
}

export const PLANS: Plan[] = [
  {
    name: "Lite",
    info: "小型团队入门之选",
    price: { monthly: 1999, yearly: Math.round(1999 * 12 * 0.88) },
    features: [
      { text: "支持 1-5 人协作使用" },
      {
        text: "每月 1 万积分",
        tooltip: "积分按月自动发放，用于图像生成与样机渲染",
      },
      { text: "最新 GPT / Gemini 图像生成模型" },
      {
        text: "PS 样机渲染功能（消耗积分）",
        tooltip: "上传 PSD 样机源文件，AI 出图一键替换图层",
      },
      { text: "7×24 小时技术支持" },
    ],
    btn: { text: "立即订阅", href: "/login" },
  },
  {
    name: "Pro",
    info: "成长型团队的首选",
    price: { monthly: 3999, yearly: Math.round(3999 * 12 * 0.88) },
    features: [
      { text: "支持 1-20 人协作使用" },
      {
        text: "每月 5 万积分",
        tooltip: "积分按月自动发放，用于图像生成与样机渲染",
      },
      { text: "最新 GPT / Gemini 图像生成模型" },
      {
        text: "PS 样机渲染功能（消耗积分）",
        tooltip: "上传 PSD 样机源文件，AI 出图一键替换图层",
      },
      { text: "7×24 小时技术支持" },
    ],
    btn: { text: "立即订阅", href: "/login" },
    highlighted: true,
  },
  {
    name: "Max",
    info: "大型组织的全能方案",
    price: { monthly: 6999, yearly: Math.round(6999 * 12 * 0.88) },
    features: [
      { text: "支持 1-50 人协作使用" },
      {
        text: "每月 10 万积分",
        tooltip: "积分按月自动发放，用于图像生成与样机渲染",
      },
      { text: "最新 GPT / Gemini 图像生成模型" },
      {
        text: "PS 样机渲染功能（消耗积分）",
        tooltip: "上传 PSD 样机源文件，AI 出图一键替换图层",
      },
      { text: "7×24 小时技术支持" },
    ],
    btn: { text: "立即订阅", href: "/login" },
  },
]

interface PricingSectionProps {
  plans: Plan[]
  heading: string
  description?: string
  className?: string
}

export default function PricingSection({
  plans,
  heading,
  description,
  className,
}: PricingSectionProps) {
  const [frequency, setFrequency] = useState<Frequency>("monthly")

  return (
    <div
      className={cn(
        "flex w-full flex-col items-center justify-center space-y-8",
        className,
      )}
    >
      <div className="mx-auto max-w-xl space-y-3">
        <h2 className="text-center text-3xl font-bold tracking-tight text-white sm:text-4xl">
          {heading}
        </h2>
        {description && (
          <p className="text-center text-sm text-white/60 sm:text-base">
            {description}
          </p>
        )}
      </div>
      <FrequencyToggle frequency={frequency} onChange={setFrequency} />
      <div className="mx-auto grid w-full max-w-4xl grid-cols-1 gap-4 md:grid-cols-3">
        {plans.map((plan) => (
          <PricingCard key={plan.name} plan={plan} frequency={frequency} />
        ))}
      </div>
    </div>
  )
}

/** 月付/年付切换：白色滑块 + transform 过渡（替代 framer-motion layoutId） */
function FrequencyToggle({
  frequency,
  onChange,
}: {
  frequency: Frequency
  onChange: (freq: Frequency) => void
}) {
  return (
    <div className="relative grid w-fit grid-cols-2 rounded-full bg-white/5 p-1 ring-1 ring-white/10 backdrop-blur">
      <span
        aria-hidden
        className={cn(
          "absolute top-1 bottom-1 left-1 w-[calc(50%-4px)] rounded-full bg-white transition-transform duration-300 ease-out",
          frequency === "yearly" && "translate-x-full",
        )}
      />
      {FREQUENCIES.map((freq) => (
        <button
          key={freq.value}
          type="button"
          onClick={() => onChange(freq.value)}
          aria-pressed={frequency === freq.value}
          className={cn(
            "relative z-10 cursor-pointer rounded-full px-6 py-1.5 text-sm font-medium transition-colors duration-300",
            frequency === freq.value
              ? "text-neutral-900"
              : "text-white/70 hover:text-white",
          )}
        >
          {freq.label}
        </button>
      ))}
    </div>
  )
}

function PricingCard({
  plan,
  frequency,
}: {
  plan: Plan
  frequency: Frequency
}) {
  const yearlyDiscount = Math.round(
    ((plan.price.monthly * 12 - plan.price.yearly) /
      plan.price.monthly /
      12) *
      100,
  )

  return (
    <div
      className={cn(
        "relative flex w-full flex-col rounded-lg border",
        plan.highlighted
          ? "border-white/15 bg-white/[0.04]"
          : "border-white/10 bg-white/[0.02]",
      )}
    >
      {plan.highlighted && <BorderTrail size={100} />}

      {/* 头部：套餐名 + 定位 + 价格，右上角徽章 */}
      <div
        className={cn(
          "relative rounded-t-lg border-b border-white/10 p-4",
          plan.highlighted ? "bg-white/[0.05]" : "bg-white/[0.03]",
        )}
      >
        <div className="absolute top-2 right-2 z-10 flex items-center gap-2">
          {plan.highlighted && (
            <p className="flex items-center gap-1 rounded-md border border-white/15 bg-neutral-950 px-2 py-0.5 text-xs text-white">
              <StarIcon className="h-3 w-3 fill-current" />
              热门
            </p>
          )}
          {frequency === "yearly" && (
            <p className="flex items-center gap-1 rounded-md border border-white bg-white px-2 py-0.5 text-xs font-medium text-neutral-900">
              省 {yearlyDiscount}%
            </p>
          )}
        </div>

        <div className="text-lg font-medium text-white">{plan.name}</div>
        <p className="text-sm font-normal text-white/50">{plan.info}</p>
        <h3 className="mt-2 flex items-end gap-1">
          <span className="text-3xl font-bold text-white">
            <span className="mr-0.5 align-top text-xl font-semibold">
              ¥
            </span>
            {plan.price[frequency].toLocaleString("zh-CN")}
          </span>
          <span className="pb-0.5 text-sm text-white/50">
            /{frequency === "monthly" ? "月" : "年"}
          </span>
        </h3>
      </div>

      {/* 特性列表：带 tooltip 的项虚线下划线 + 纯 CSS 悬停气泡 */}
      <div className="flex-1 space-y-4 px-4 py-6 text-sm">
        {plan.features.map((feature) => (
          <div key={feature.text} className="flex items-center gap-2">
            <CheckCircleIcon className="h-4 w-4 shrink-0 text-white/70" />
            {feature.tooltip ? (
              <span className="group/tip relative inline-block">
                <span className="cursor-help border-b border-dashed border-white/30 text-white/70">
                  {feature.text}
                </span>
                <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 w-max max-w-56 -translate-x-1/2 rounded-md border border-white/10 bg-neutral-900 px-3 py-1.5 text-xs leading-relaxed text-white/80 opacity-0 shadow-lg transition-opacity duration-150 group-hover/tip:opacity-100">
                  {feature.tooltip}
                </span>
              </span>
            ) : (
              <span className="text-white/70">{feature.text}</span>
            )}
          </div>
        ))}
      </div>

      {/* 底部按钮：mt-auto 保证三卡等高时按钮贴底 */}
      <div className="mt-auto w-full border-t border-white/10 p-3">
        <a
          href={plan.btn.href}
          className={cn(
            "inline-flex h-10 w-full cursor-pointer items-center justify-center rounded-md text-sm font-medium transition-colors",
            plan.highlighted
              ? "bg-white text-neutral-900 hover:bg-white/90"
              : "border border-white/15 text-white hover:bg-white/10",
          )}
        >
          {plan.btn.text}
        </a>
      </div>
    </div>
  )
}

/** 流光描边：光点沿卡片边框矩形路径绕圈（CSS offset-distance 动画） */
function BorderTrail({
  size = 60,
  className,
  style,
}: {
  size?: number
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 rounded-[inherit] border border-transparent [mask-clip:padding-box,border-box] [mask-composite:intersect] [mask-image:linear-gradient(transparent,transparent),linear-gradient(#000,#000)]"
    >
      <div
        className={cn(
          "animate-border-trail absolute aspect-square rounded-full bg-white",
          className,
        )}
        style={{
          width: size,
          offsetPath: `rect(0 auto auto 0 round ${size}px)`,
          boxShadow:
            "0 0 18px 6px rgb(255 255 255 / 60%), 0 0 42px 18px rgb(255 255 255 / 25%)",
          ...style,
        }}
      />
    </div>
  )
}
