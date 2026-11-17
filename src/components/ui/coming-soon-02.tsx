"use client"

// Coming Soon 2 from Hirael <https://hirael.com/blocks/not-found/coming-soon-02>
// MIT · Mohammad Shehadeh · https://github.com/MohammadShehadeh/hirael
//
// 本地适配：
// - 中文化 + 参数化：标题/描述由调用方传入（各占位页定制）；中文标题按
//   「字符」切分入场（原版按空格分词对中文失效），去掉英文前后半分色
//   （短中文标题统一 text-foreground 更干净）；徽章「即将上线」「功能开发中」；
// - Badge 换项目 base-ui 版；配色沿用项目 shadcn token（light/dark 自动适配），
//   不引入模板 demo 的 oklch 主题；
// - 布局适配 dashboard 内容区：min-h-svh → min-h-[60vh]，地平线区等比缩小。

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Sparkles } from "@/components/ui/coming-soon-02-utils/sparkles"

export interface ComingSoon02Props {
  /** 大标题（按字符逐个入场） */
  title: string
  /** 一句话功能预告 */
  description?: string
  className?: string
}

export function ComingSoon02({
  title,
  description,
  className,
}: ComingSoon02Props) {
  const reduce = useReducedMotion()
  const chars = React.useMemo(() => Array.from(title), [title])

  return (
    <section
      data-slot="coming-soon"
      className={cn(
        "relative isolate flex min-h-[60vh] flex-col items-center justify-center overflow-hidden rounded-lg bg-background",
        className,
      )}
    >
      <motion.div
        data-slot="coming-soon-body"
        className="relative z-10 mx-auto flex w-full max-w-3xl flex-col items-center gap-5 px-6 pt-10 text-center md:px-10"
        initial={reduce ? false : { opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.8, ease: "easeOut" }}
      >
        <motion.div
          initial={reduce ? false : { opacity: 0, scale: 0.9 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease: "easeOut", delay: 0.3 }}
        >
          <Badge
            variant="outline"
            data-slot="coming-soon-badge"
            className="rounded-full bg-card/70 px-4 py-1.5 font-mono text-[10px] tracking-[0.14em] text-muted-foreground backdrop-blur-sm"
          >
            即将上线
          </Badge>
        </motion.div>

        {/* 页面标题以 dashboard header 的 h1 为准，这里降为 h2（各占位页同页双 h1） */}
        <h2
          data-slot="coming-soon-title"
          className="max-w-xl font-serif text-5xl font-medium leading-[1.08] tracking-tight text-foreground sm:text-6xl md:text-7xl"
        >
          {chars.map((char, i) => (
            <motion.span
              key={`${char}-${i}`}
              className="inline-block"
              initial={reduce ? false : { opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{
                duration: 0.5,
                ease: "easeOut",
                delay: 0.2 + i * 0.08,
              }}
            >
              {/* 空白字符换 nbsp 占位，避免 inline-block 逐字符切分后空格塌陷 */}
              {char === " " ? "\u00A0" : char}
            </motion.span>
          ))}
        </h2>

        {description && (
          <motion.p
            data-slot="coming-soon-description"
            className="mt-2 max-w-2xl text-pretty text-base text-muted-foreground sm:text-lg"
            initial={reduce ? false : { opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.4 + chars.length * 0.08 }}
          >
            {description}
          </motion.p>
        )}

        <motion.div
          data-slot="coming-soon-actions"
          className="mt-4 flex flex-col items-center gap-4 sm:flex-row"
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{
            duration: 0.6,
            delay: 0.6 + chars.length * 0.08,
          }}
        >
          <Badge
            variant="outline"
            data-slot="coming-soon-cta"
            className="rounded-full px-5 py-2 text-sm font-medium"
          >
            功能开发中
          </Badge>
        </motion.div>
      </motion.div>

      {/* 地平线：弧形轮廓 + 主色辉光 + 星点粒子 */}
      <div
        data-slot="coming-soon-horizon"
        aria-hidden
        className="relative -mt-20 h-64 w-full overflow-hidden [mask-image:radial-gradient(50%_50%,black,transparent)] after:absolute after:-start-1/2 after:top-1/2 after:aspect-[1/0.7] after:w-[200%] after:rounded-[100%] after:border-t after:border-border after:bg-card after:content-['']"
      >
        <div
          data-slot="coming-soon-horizon-glow"
          className="absolute inset-0 bg-[radial-gradient(circle_at_50%_100%,color-mix(in_oklch,var(--primary)_40%,transparent),transparent_70%)] opacity-40"
        />
        <Sparkles
          density={4}
          size={1.4}
          color="var(--primary)"
          className="[mask-image:radial-gradient(50%_50%,black,transparent_85%)]"
        />
      </div>
    </section>
  )
}

export default ComingSoon02
