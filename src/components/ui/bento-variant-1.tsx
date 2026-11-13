"use client"

import { motion } from "motion/react"
import { cn } from "@/lib/utils"

/**
 * 21st.dev bento-variant-1 模板（Bento 功能卡矩阵）。
 * 原模板两处本地适配：framer-motion → motion/react（项目未装 framer-motion，
 * 先例见 kpi-tile.tsx）；font-geistMono → font-mono（globals.css 的 @theme 映射）。
 * 配图保持模板原图（cdn.21st.dev 外链）。
 * 营销页深色中文版在 marketing/bento-features-section.tsx，复用下方 BentoCard。
 */
export default function FUIBentoGridDark() {
  return (
    <section className="w-full bg-[#e8e8ea] text-neutral-950">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col px-5 pb-14 pt-14 sm:px-8 lg:px-10 lg:pb-16 lg:pt-16">
        <header className="grid grid-cols-1 gap-3 lg:grid-cols-6 lg:items-end lg:gap-2">
          <h1 className="font-mono text-4xl tracking-tight md:text-5xl lg:col-span-2">
            Sales
          </h1>
          <p className="max-w-xl bg-gradient-to-r from-black via-black/80 to-black/45 bg-clip-text text-xl/7 font-medium tracking-tight text-transparent sm:text-2xl/8 lg:col-span-4 lg:justify-self-end lg:text-right">
            Know more about your customers than they do.
          </p>
        </header>

        <div className="mt-5 h-px w-full bg-black/10 lg:mt-6" />

        <div
          className={cn(
            "-mx-5 mt-5 flex snap-x snap-mandatory gap-2 overflow-x-auto scroll-px-5 px-5 pb-2 sm:-mx-8 sm:scroll-px-8 sm:px-8",
            "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            "lg:mx-0 lg:mt-6 lg:grid lg:grid-cols-6 lg:overflow-visible lg:px-0 lg:pb-0",
          )}
        >
          <BentoCard
            eyebrow="Insight"
            title="Get perfect clarity"
            description="PerkAI uses social engineering to build a detailed financial picture of your leads. Know their budget, compensation package, social security number, and more."
            graphic={
              <div className="absolute inset-0 bg-cover bg-[position:70%_30%] bg-[url(https://cdn.21st.dev/assets/mirror/82/8216d38fc7b6e661002e520eceae40f036741db2f2281729f62bc2885f168bff.png)]" />
            }
            className="lg:col-span-3 lg:rounded-[2rem_0.5rem_0.5rem_0.5rem]"
          />
          <BentoCard
            eyebrow="Analysis"
            title="Undercut your competitors"
            description="With our advanced data mining, you’ll know which companies your leads are talking to and exactly how much they’re being charged."
            graphic={
              <div className="absolute inset-0 bg-cover bg-[position:60%_40%] bg-[url(https://cdn.21st.dev/assets/mirror/38/388b12fd04fd758f8af4db4ff90a362fdefabc172e3f532d6595f2ba4a86a76b.png)]" />
            }
            className="lg:col-span-3 lg:rounded-[0.5rem_2rem_0.5rem_0.5rem]"
          />
          <BentoCard
            eyebrow="Speed"
            title="Built for power users"
            description="It’s never been faster to cold email your entire contact list using our streamlined keyboard shortcuts."
            graphic={
              <div className="absolute inset-0 bg-black bg-cover bg-[position:30%_20%] bg-[url(https://cdn.21st.dev/assets/mirror/e1/e11e231bc3af40fd287e47edf1ae6caf40f5421f6fadee45b6e10a635ddea8c0.png)]" />
            }
            className="lg:col-span-2 lg:rounded-[0.5rem_0.5rem_0.5rem_2rem]"
          />
          <BentoCard
            eyebrow="Source"
            title="Get the furthest reach"
            description="Bypass those inconvenient privacy laws to source leads from the most unexpected places."
            graphic={
              <div className="absolute inset-0 bg-center bg-cover bg-[url(https://cdn.21st.dev/assets/mirror/05/05a9718924c99a9e5c6d5a61b9ea8d088c6f2ce2515716d60f69064dc178462f.png)]" />
            }
            className="lg:col-span-2 lg:rounded-[0.5rem]"
          />
          <BentoCard
            eyebrow="Limitless"
            title="Sell globally"
            description="PerkAI helps you sell in locations currently under international embargo."
            graphic={
              <div className="absolute inset-0 bg-cover bg-[position:30%_20%] bg-[url(https://cdn.21st.dev/assets/mirror/1a/1aa128de57f039b2b380e36a1b540ebbabe497490bb78e07ec6ab8c8cb9383f8.png)]" />
            }
            className="lg:col-span-2 lg:rounded-[0.5rem_0.5rem_2rem_0.5rem]"
          />
        </div>
      </div>
    </section>
  )
}

export function BentoCard({
  dark = false,
  className = "",
  eyebrow,
  title,
  description,
  graphic,
  fade = [],
}: {
  dark?: boolean
  className?: string
  eyebrow: React.ReactNode
  title: React.ReactNode
  description: React.ReactNode
  graphic?: React.ReactNode
  fade?: ("top" | "bottom")[]
}) {
  return (
    <motion.div
      initial="idle"
      whileHover="active"
      variants={{ idle: {}, active: {} }}
      data-dark={dark ? "true" : undefined}
      className={cn(
        "group relative isolate flex w-[82%] shrink-0 snap-start flex-col overflow-hidden rounded-[1.75rem] bg-black shadow-[0_1px_2px_rgba(0,0,0,0.08),0_12px_32px_-16px_rgba(0,0,0,0.35)] transform-gpu",
        "sm:w-[22rem] lg:w-auto lg:shrink",
        "data-[dark]:bg-gray-800",
        className,
      )}
    >
      <div className="relative h-[21rem] shrink-0 overflow-hidden sm:h-[22rem] lg:h-[16rem]">
        <motion.div
          className="absolute inset-0"
          variants={{ idle: { scale: 1 }, active: { scale: 1.045 } }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        >
          {graphic}
        </motion.div>
        {fade.includes("top") && (
          <div className="absolute inset-0 bg-gradient-to-b from-white to-50% opacity-25 group-data-[dark]:from-gray-800 group-data-[dark]:from-[-25%]" />
        )}
        {fade.includes("bottom") && (
          <div className="absolute inset-0 bg-gradient-to-t from-white to-50% opacity-25 group-data-[dark]:from-gray-800 group-data-[dark]:from-[-25%]" />
        )}
      </div>

      <div className="relative z-20 -mt-16 flex flex-1 flex-col border-t border-white/[0.08] bg-gradient-to-b from-black/25 via-black/55 to-black/75 p-6 text-white backdrop-blur-xl">
        <h1 className="text-[11px] font-medium uppercase tracking-[0.16em] text-indigo-100/80">
          {eyebrow}
        </h1>
        <div
          aria-hidden
          className="mt-3 h-px w-full bg-gradient-to-r from-white/25 via-white/10 to-white/0"
        />
        <p className="mt-3 bg-gradient-to-br from-white to-white/65 bg-clip-text text-xl/7 font-medium tracking-tight text-transparent">
          {title}
        </p>
        <p className="mt-1.5 max-w-[34rem] text-sm/6 text-gray-300 group-data-[dark]:text-gray-400">
          {description}
        </p>
      </div>

      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-30 rounded-[inherit] ring-1 ring-inset ring-white/10 [box-shadow:inset_0_-24px_80px_-24px_rgba(134,134,240,0.32)] group-data-[dark]:ring-white/15"
      />
    </motion.div>
  )
}
