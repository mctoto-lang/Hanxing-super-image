"use client"

import { useState } from "react"
import { CheckCircleIcon, StarIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import SubscribeReceiptDialog from "./subscribe-receipt-dialog"

/**
 * 积分套餐区块（marketing 落地页「积分套餐」锚点）
 *
 * 改写自 Launch UI pricing 模板：原版依赖 framer-motion（月/年切换滑块的
 * layoutId 动画、BorderTrail 的 offsetDistance 补间），这里全部换成纯 CSS——
 * 滑块用 transform transition，流光用 globals.css 里的 @keyframes borderTrail
 * 驱动 offset-distance。配色不用 shadcn token，直接对齐落地页的深色白系
 * （bg-neutral-950 + white/xx），避免营销页未挂 .dark 时 token 失真。
 */

export type Frequency = "monthly" | "yearly"

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: "monthly", label: "月付" },
  { value: "yearly", label: "年付" },
]

interface PlanFeature {
  text: string
  tooltip?: string
  /** 积分小票上的短标签（保证单行不换行；缺省回退 text） */
  receipt?: string
}

export interface Plan {
  name: string
  info: string
  /** 年付价为月付 ×12 打 88 折（与折扣徽章的计算保持一致） */
  price: { monthly: number; yearly: number }
  features: PlanFeature[]
  /** 按钮文案（点击弹积分小票弹窗，无跳转） */
  btn: { text: string }
  highlighted?: boolean
}

/**
 * 暂时隐藏售价与计费周期：月付/年付均显示 ¥0（「省 %」徽标同步隐藏），
 * 月付/年付切换与「/月|/年」价格单位随 SHOW_BILLING_TOGGLE 一并隐藏。
 * 恢复时把各档 monthly 改回原月价（yearly 恢复 88 折公式
 * Math.round(月价 * 12 * 0.88)），并将 SHOW_BILLING_TOGGLE 改回 true。
 */
const SHOW_BILLING_TOGGLE = false
export const PLANS: Plan[] = [
  {
    name: "Lite",
    info: "小型团队入门之选",
    price: { monthly: 0, yearly: 0 }, // 原月价 99
    features: [
      { text: "支持 1-5 人协作使用", receipt: "协作席位 5 人内" },
      {
        text: "每月 9,900 基础积分 + 赠送 300",
        tooltip: "月度合计 10,200 积分，按月自动发放，用于图像生成与样机渲染",
        receipt: "积分 9,900 + 赠 300",
      },
      {
        text: "基础生图模型 可用约 340 次",
        receipt: "AI 生图 约 340 次",
      },
      {
        text: "PS 样机渲染功能（消耗积分）",
        tooltip: "上传 PSD 样机源文件，AI 出图一键替换图层",
        receipt: "PS 样机渲染",
      },
      { text: "7×24 小时技术支持", receipt: "7×24 技术支持" },
    ],
    btn: { text: "获取积分" },
  },
  {
    name: "Pro",
    info: "成长型团队的首选",
    price: { monthly: 0, yearly: 0 }, // 原月价 199
    features: [
      { text: "支持 1-20 人协作使用", receipt: "协作席位 20 人内" },
      {
        text: "每月 19,900 基础积分 + 赠送 1,100",
        tooltip: "月度合计 21,000 积分，按月自动发放，用于图像生成与样机渲染",
        receipt: "积分 19,900 + 赠 1,100",
      },
      {
        text: "基础生图模型 可用约 700 次",
        receipt: "AI 生图 约 700 次",
      },
      {
        text: "PS 样机渲染功能（消耗积分）",
        tooltip: "上传 PSD 样机源文件，AI 出图一键替换图层",
        receipt: "PS 样机渲染",
      },
      { text: "7×24 小时技术支持", receipt: "7×24 技术支持" },
    ],
    btn: { text: "获取积分" },
  },
  {
    name: "Ultra",
    info: "进阶团队的高性价比之选",
    price: { monthly: 0, yearly: 0 }, // 原月价 399
    features: [
      { text: "支持 1-50 人协作使用", receipt: "协作席位 50 人内" },
      {
        text: "每月 39,900 基础积分 + 赠送 3,000",
        tooltip: "月度合计 42,900 积分，按月自动发放，用于图像生成与样机渲染",
        receipt: "积分 39,900 + 赠 3,000",
      },
      {
        text: "基础生图模型 可用约 1,430 次",
        receipt: "AI 生图 约 1,430 次",
      },
      {
        text: "PS 样机渲染功能（消耗积分）",
        tooltip: "上传 PSD 样机源文件，AI 出图一键替换图层",
        receipt: "PS 样机渲染",
      },
      { text: "7×24 小时技术支持", receipt: "7×24 技术支持" },
    ],
    btn: { text: "获取积分" },
    highlighted: true,
  },
  {
    name: "Max",
    info: "大型组织的全能方案",
    price: { monthly: 0, yearly: 0 }, // 原月价 599
    features: [
      { text: "支持 1-100 人协作使用", receipt: "协作席位 100 人内" },
      {
        text: "每月 59,900 基础积分 + 赠送 5,980",
        tooltip: "月度合计 65,880 积分，按月自动发放，用于图像生成与样机渲染",
        receipt: "积分 59,900 + 赠 5,980",
      },
      {
        text: "基础生图模型 可用约 2,196 次",
        receipt: "AI 生图 约 2,196 次",
      },
      {
        text: "PS 样机渲染功能（消耗积分）",
        tooltip: "上传 PSD 样机源文件，AI 出图一键替换图层",
        receipt: "PS 样机渲染",
      },
      { text: "7×24 小时技术支持", receipt: "7×24 技术支持" },
    ],
    btn: { text: "获取积分" },
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
  // 点「获取积分」弹小票打印机弹窗（无在线支付，扫码联系客服激活）
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null)

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
      {/* 暂时隐藏月付/年付切换（恢复点：SHOW_BILLING_TOGGLE） */}
      {SHOW_BILLING_TOGGLE && (
        <FrequencyToggle frequency={frequency} onChange={setFrequency} />
      )}
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {plans.map((plan) => (
          <PricingCard
            key={plan.name}
            plan={plan}
            frequency={frequency}
            onSubscribe={() => setSelectedPlan(plan)}
          />
        ))}
      </div>
      <SubscribeReceiptDialog
        frequency={frequency}
        onOpenChange={(next) => {
          if (!next) {
            setSelectedPlan(null)
          }
        }}
        open={selectedPlan !== null}
        plan={selectedPlan}
      />
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
  onSubscribe,
}: {
  plan: Plan
  frequency: Frequency
  onSubscribe: () => void
}) {
  // 暂时隐藏售价（monthly/yearly=0）时无折扣可言，置 0 并由渲染处隐藏徽标
  // （恢复定价若只改回 monthly，yearly 仍为 0 会算出「省 100%」——徽标守卫
  // 同时要求 monthly、yearly 均 > 0）
  const yearlyDiscount =
    plan.price.monthly > 0
      ? Math.round(
          ((plan.price.monthly * 12 - plan.price.yearly) /
            plan.price.monthly /
            12) *
            100,
        )
      : 0

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
          {frequency === "yearly" && plan.price.monthly > 0 && plan.price.yearly > 0 && (
            <p className="flex items-center gap-1 rounded-md border border-white bg-white px-2 py-0.5 text-xs font-medium text-neutral-900">
              省 {yearlyDiscount}%
            </p>
          )}
        </div>

        <div className="text-lg font-medium text-white">{plan.name}</div>
        <p className="text-sm font-normal text-white/50">{plan.info}</p>
        {/* 价格=0（暂时隐藏售价）时整块不渲染，避免卡片露「¥0」；恢复定价后自动回来 */}
        {plan.price[frequency] > 0 && (
          <h3 className="mt-2 flex items-end gap-1">
            <span className="text-3xl font-bold text-white">
              <span className="mr-0.5 align-top text-xl font-semibold">
                ¥
              </span>
              {plan.price[frequency].toLocaleString("zh-CN")}
            </span>
            {/* 暂时隐藏「/月|/年」价格单位（恢复点：SHOW_BILLING_TOGGLE） */}
            {SHOW_BILLING_TOGGLE && (
              <span className="pb-0.5 text-sm text-white/50">
                /{frequency === "monthly" ? "月" : "年"}
              </span>
            )}
          </h3>
        )}
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

      {/* 底部按钮：mt-auto 保证三卡等高时按钮贴底；点击弹积分小票弹窗 */}
      <div className="mt-auto w-full border-t border-white/10 p-3">
        <button
          type="button"
          onClick={onSubscribe}
          className={cn(
            "inline-flex h-10 w-full cursor-pointer items-center justify-center rounded-md text-sm font-medium transition-colors",
            plan.highlighted
              ? "bg-white text-neutral-900 hover:bg-white/90"
              : "border border-white/15 text-white hover:bg-white/10",
          )}
        >
          {plan.btn.text}
        </button>
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
