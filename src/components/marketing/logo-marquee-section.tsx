"use client"

import type { ReactNode } from "react"
import { Icon } from "@iconify/react"
import amazonIcon from "@iconify-icons/selfhst/amazon"
import temuIcon from "@iconify-icons/selfhst/temu"
import ozonIcon from "@iconify-icons/thesvg-color/ozon"
import mercadoLibreIcon from "@iconify-icons/thesvg-color/mercado-libre"
import { SiAliexpress, SiEbay, SiEtsy, SiTiktok } from "@icons-pack/react-simple-icons"
import { Claude, DeepSeek, Gemini, Grok, Kimi, OpenAI, Qwen, Zhipu } from "@lobehub/icons"
import { cn } from "@/lib/utils"

/* Logo 墙：双行反向跑马灯（电商平台 × AI 模型），位于 Bento 功能矩阵与订阅套餐之间。
   图标全部来自组件库，无手绘 SVG：
   - AI 模型行：@lobehub/icons（官方彩色 .Color 变体；OpenAI/Grok 官方 logo 为黑色，深色底渲染白色）
   - 电商平台行：@icons-pack/react-simple-icons（simple-icons 封装，品牌色）
     + @iconify/react 配 @iconify-icons/selfhst、@iconify-icons/thesvg-color 按图标数据
     （simple-icons 因商标政策未收录 Amazon/Temu/Ozon/Mercado Libre）
   滚动复用 globals.css 的 .animate-marquee / .animate-marquee-reverse（无缝循环 + reduced-motion 兜底），
   行结构照抄 testimonials-section.tsx 的 MarqueeRow 模式：并排 N 份拷贝各自动画 */

/** 每份拷贝的份数：拷贝宽度 × REPEAT 需远大于视口宽才能全程无缝 */
const REPEAT = 4

interface LogoItem {
  name: string
  icon: ReactNode
}

/** selfhst 的 Amazon 图标：字母 "a" 的 path 未带 fill（SVG 默认渲染黑色），深色底不可见，
    负向前瞻只给缺失 fill 的 path 补白色，与橙色微笑箭头搭配（用户定稿：a 白色） */
const amazonColorIcon = {
  ...amazonIcon,
  body: amazonIcon.body.replace(/<path(?![^>]*\bfill=)/g, '<path fill="#FFFFFF"'),
}

const PLATFORM_LOGOS: LogoItem[] = [
  { name: "Amazon", icon: <Icon icon={amazonColorIcon} height={24} width={24} /> },
  { name: "Temu", icon: <Icon icon={temuIcon} height={24} width={24} /> },
  { name: "AliExpress", icon: <SiAliexpress size={24} color="#FF4747" /> },
  // TikTok 品牌色为纯黑，深色底不可见，渲染白色
  { name: "TikTok Shop", icon: <SiTiktok size={24} color="#FFFFFF" /> },
  { name: "eBay", icon: <SiEbay size={24} color="#E53238" /> },
  { name: "Ozon", icon: <Icon icon={ozonIcon} height={24} width={24} /> },
  { name: "Etsy", icon: <SiEtsy size={24} color="#F16521" /> },
  { name: "Mercado Libre", icon: <Icon icon={mercadoLibreIcon} height={24} width={24} /> },
]

const MODEL_LOGOS: LogoItem[] = [
  { name: "Claude", icon: <Claude.Color size={24} /> },
  { name: "Gemini", icon: <Gemini.Color size={24} /> },
  { name: "GPT", icon: <OpenAI size={24} color="#FFFFFF" /> },
  { name: "Grok", icon: <Grok size={24} color="#FFFFFF" /> },
  { name: "Qwen", icon: <Qwen.Color size={24} /> },
  { name: "GLM", icon: <Zhipu.Color size={24} /> },
  { name: "Kimi", icon: <Kimi.Color size={24} /> },
  { name: "DeepSeek", icon: <DeepSeek.Color size={24} /> },
]

/** 单行跑马灯：并排 REPEAT 份拷贝各自动画，反向行用 animation-direction */
function MarqueeRow({ items, reverse = false }: { items: LogoItem[]; reverse?: boolean }) {
  return (
    <div className="relative">
      <div className="group flex overflow-hidden p-1 [--gap:3rem] [--duration:50s] [gap:var(--gap)]">
        {[...Array(REPEAT)].map((_, setIndex) => (
          <div
            key={setIndex}
            aria-hidden={setIndex > 0}
            className={cn(
              "flex shrink-0 items-center [gap:var(--gap)] group-hover:[animation-play-state:paused]",
              reverse ? "animate-marquee-reverse" : "animate-marquee",
            )}
          >
            {items.map((item, i) => (
              <span
                key={`${setIndex}-${i}`}
                className="flex shrink-0 items-center gap-2.5"
              >
                {item.icon}
                <span className="text-lg font-bold tracking-tight text-white/75">
                  {item.name}
                </span>
              </span>
            ))}
          </div>
        ))}
      </div>
      {/* 边缘渐隐遮罩：logo 在两侧淡入淡出，仅 sm 以上显示 */}
      <div className="pointer-events-none absolute inset-y-0 left-0 hidden w-40 bg-gradient-to-r from-neutral-950 sm:block" />
      <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-40 bg-gradient-to-l from-neutral-950 sm:block" />
    </div>
  )
}

export default function LogoMarqueeSection() {
  return (
    <section aria-label="已接入平台与模型" className="bg-neutral-950 py-16 md:py-24">
      <div className="flex flex-col gap-14 md:gap-16">
        {/* 上行：电商平台，向左滚动 */}
        <MarqueeRow items={PLATFORM_LOGOS} />
        {/* 下行：AI 模型，向右滚动 */}
        <MarqueeRow items={MODEL_LOGOS} reverse />
      </div>
    </section>
  )
}
