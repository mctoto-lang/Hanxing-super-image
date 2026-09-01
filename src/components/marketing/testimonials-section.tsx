"use client"

import { cn } from "@/lib/utils"

/**
 * 用户评价跑马灯区块（marketing 落地页「用户评价」锚点）
 *
 * 改写自 21st.dev serafimcloud/testimonials-with-marquee 模板：
 * - 无缝循环结构修正——原模板把 4 份拷贝嵌在同一个动画元素里，
 *   translateX(-100%) 按整条带子宽度位移，每轮结尾会露空跳变；这里
 *   改为外层并排放 4 份拷贝、每份各自位移自身宽度（关键帧不变），
 *   循环点前后画面完全一致，真正无缝
 * - 双行反向：第一行向左，第二行 animation-direction: reverse 向右
 * - 配色不用 shadcn token，直接对齐落地页深色白系
 *   （bg-neutral-950 + white/xx），头像按落地页惯例用原生 <img>
 * - prefers-reduced-motion 时停用滚动（globals.css），卡片静态平铺
 */

export interface Testimonial {
  author: {
    name: string
    handle: string
    avatar: string
  }
  text: string
  /** 传入则整卡渲染为链接 */
  href?: string
}

/** 占位内容：先按平台典型用户角色拟稿，文案与头像后续替换真实内容 */
export const TESTIMONIAL_ROW_1: Testimonial[] = [
  {
    author: {
      name: "林晚秋",
      handle: "@linwanqiu",
      avatar:
        "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&h=150&fit=crop&crop=face",
    },
    text: "商品图片以前要拍一天，现在输入描述几分钟出图，质感直接对标摄影棚，详情页改版效率翻倍。",
  },
  {
    author: {
      name: "陈默",
      handle: "@chenmo-brand",
      avatar:
        "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&h=150&fit=crop&crop=face",
    },
    text: "团队用统一的视觉风格批量生成节日海报，上百个 SKU 的素材一晚上全部到位，这在以前不敢想。",
  },
  {
    author: {
      name: "苏一帆",
      handle: "@suyifan",
      avatar:
        "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&h=150&fit=crop&crop=face",
    },
    text: "草图阶段的概念探索特别省心，一句话就能看到好几种风格方向，灵感枯竭的时候简直是外挂。",
  },
  {
    author: {
      name: "周雨薇",
      handle: "@zhouyuwei",
      avatar:
        "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150&h=150&fit=crop&crop=face",
    },
    text: "公众号封面和配图再也不用到处找图了，生成的图没有版权顾虑，风格还能和账号调性保持一致。",
  },
]

export const TESTIMONIAL_ROW_2: Testimonial[] = [
  {
    author: {
      name: "高远",
      handle: "@gaoyuan",
      avatar:
        "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&h=150&fit=crop&crop=face",
    },
    text: "场景概念图出图速度飞快，反复调整提示词就能逼近想要的氛围，前期沟通成本降了一大截。",
  },
  {
    author: {
      name: "沈亦可",
      handle: "@shenyike",
      avatar:
        "https://images.unsplash.com/photo-1633332755192-727a05c4013d?w=150&h=150&fit=crop&crop=face",
    },
    text: "人像精修前先用它做风格预演，客户确认方向后再动手修图，返工率肉眼可见地下降。",
  },
  {
    author: {
      name: "郭子昂",
      handle: "@guoziang",
      avatar:
        "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&h=150&fit=crop&crop=face",
    },
    text: "给我的小程序做启动页和宣传素材，一个人顶一个小团队，出图质量完全够上架标准。",
  },
  {
    author: {
      name: "许清扬",
      handle: "@xuqingyang",
      avatar:
        "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150&h=150&fit=crop&crop=face",
    },
    text: "投放素材需要不停 A/B 测试，现在批量生成多版本创意，点击率比手动出图还高。",
  },
]

/** 跑马灯里每份拷贝重复的次数（保证任意视口宽度下都有卡片补位） */
const REPEAT = 4

export function TestimonialCard({
  testimonial,
  className,
}: {
  testimonial: Testimonial
  className?: string
}) {
  const { author, text, href } = testimonial
  const Card = href ? "a" : "figure"

  return (
    <Card
      {...(href ? { href } : {})}
      className={cn(
        "flex w-[320px] shrink-0 flex-col rounded-lg border-t border-white/10",
        "bg-gradient-to-b from-white/[0.06] to-white/[0.02]",
        "p-4 transition-colors duration-300 sm:p-6",
        "hover:from-white/[0.10] hover:to-white/[0.04]",
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <img
          src={author.avatar}
          alt={author.name}
          className="size-12 rounded-full object-cover"
        />
        <div className="flex flex-col items-start">
          <h3 className="text-sm leading-none font-semibold text-white">
            {author.name}
          </h3>
          <p className="mt-1 text-xs text-white/50">{author.handle}</p>
        </div>
      </div>
      <blockquote className="mt-4 text-sm leading-relaxed text-white/60">
        {text}
      </blockquote>
    </Card>
  )
}

/** 单行跑马灯：并排 REPEAT 份拷贝各自动画，反向行用 animation-direction */
function MarqueeRow({
  items,
  reverse = false,
}: {
  items: Testimonial[]
  reverse?: boolean
}) {
  return (
    <div className="relative">
      <div className="group flex overflow-hidden p-2 [--gap:1rem] [--duration:40s] [gap:var(--gap)]">
        {[...Array(REPEAT)].map((_, setIndex) => (
          <div
            key={setIndex}
            className={cn(
              "flex shrink-0 justify-around [gap:var(--gap)] group-hover:[animation-play-state:paused]",
              reverse ? "animate-marquee-reverse" : "animate-marquee",
            )}
          >
            {items.map((testimonial, i) => (
              <TestimonialCard
                key={`${setIndex}-${i}`}
                testimonial={testimonial}
              />
            ))}
          </div>
        ))}
      </div>
      {/* 边缘渐隐遮罩：卡片在两侧淡入淡出，仅 sm 以上显示 */}
      <div className="pointer-events-none absolute inset-y-0 left-0 hidden w-1/3 bg-gradient-to-r from-neutral-950 sm:block" />
      <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-1/3 bg-gradient-to-l from-neutral-950 sm:block" />
    </div>
  )
}

export default function TestimonialsSection({
  heading,
  description,
}: {
  heading: string
  description: string
}) {
  return (
    <div>
      <div className="mx-auto max-w-7xl">
        <h2 className="text-center text-3xl font-bold tracking-tight text-white sm:text-4xl">
          {heading}
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-sm text-white/50 sm:text-base">
          {description}
        </p>
      </div>

      {/* -mx-6 抵消外层 section 的 px-6，跑马灯全出血贴视口边缘 */}
      <div className="-mx-6 mt-12 flex flex-col gap-4 sm:mt-16">
        <MarqueeRow items={TESTIMONIAL_ROW_1} />
        <MarqueeRow items={TESTIMONIAL_ROW_2} reverse />
      </div>
    </div>
  )
}
