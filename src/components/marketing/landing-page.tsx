"use client"

import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react"
import { ArrowRight, ArrowUpRight, Menu, X } from "lucide-react"
import { cn } from "@/lib/utils"
import StarfieldSection from "@/components/marketing/starfield-section"
import PricingSection, { PLANS } from "@/components/marketing/pricing-section"
import FaqSection from "@/components/marketing/faq-section"
import TestimonialsSection from "@/components/marketing/testimonials-section"
import FooterSection from "@/components/marketing/footer-section"

const LOGO_URL =
  "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/febf2421-4a9a-42d6-871d-ff4f9518021c_1600w.png"
const BACKGROUND_IMAGE_URL =
  "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/0e2dbea0-c0a9-413f-a57b-af279633c0df_3840w.jpg"

const NAV_LINKS = [
  { id: "home", label: "首页" },
  { id: "features", label: "产品功能" },
  { id: "pricing", label: "订阅套餐" },
  { id: "testimonials", label: "用户评价" },
  { id: "help", label: "帮助中心" },
] as const

const PARTNERS = [
  "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/f7466370-2832-4fdd-84c2-0932bb0dd850_800w.png",
  "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/0a9a71ec-268b-4689-a510-56f57e9d4f13_1600w.png",
  "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/a9ed4369-748a-49f8-9995-55d6c876bbff_1600w.png",
  "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/0d8966a4-8525-4e11-9d5d-2d7390b2c798_1600w.png",
  "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/2ed33c8b-b8b2-4176-967f-3d785fed07d8_1600w.png",
]

/**
 * 登录前的营销首页：单页下拉式，五个锚点区块（首页 / 产品功能 / 订阅套餐 /
 * 用户评价 / 帮助中心），导航吸顶 + 点击平滑滚动 + 滚动高亮当前区块。
 */
export default function LandingPage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [activeId, setActiveId] = useState<string>("home")
  /** 进行中的锚点滚动动画（rAF id），新动画或用户滚动时取消 */
  const scrollRafRef = useRef<number | null>(null)

  const cancelScrollAnimation = useCallback(() => {
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = null
    }
  }, [])

  // 隐藏浏览器滚动条（globals.css 已定义 scrollbar-hide 工具类；卸载时恢复）
  useEffect(() => {
    document.documentElement.classList.add("scrollbar-hide")
    return () => document.documentElement.classList.remove("scrollbar-hide")
  }, [])

  // 用户滚轮/触摸时中断锚点动画，交还滚动控制权
  useEffect(() => {
    window.addEventListener("wheel", cancelScrollAnimation, { passive: true })
    window.addEventListener("touchstart", cancelScrollAnimation, {
      passive: true,
    })
    return () => {
      window.removeEventListener("wheel", cancelScrollAnimation)
      window.removeEventListener("touchstart", cancelScrollAnimation)
      cancelScrollAnimation()
    }
  }, [cancelScrollAnimation])

  // 滚动监听：高亮视口中部所在的区块
  useEffect(() => {
    const sections = NAV_LINKS.map((link) =>
      document.getElementById(link.id),
    ).filter((el): el is HTMLElement => el !== null)
    if (sections.length === 0) return

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveId(entry.target.id)
        }
      },
      // 视口中间 5% 的横带命中的区块视为当前区块
      { rootMargin: "-47.5% 0px -47.5% 0px" },
    )
    sections.forEach((section) => io.observe(section))
    return () => io.disconnect()
  }, [])

  // 锚点滚动：自驱动 rAF 动画精确停靠——scrollIntoView 的原生 smooth
  // 会被滚轮/触摸打断停在半路，且停靠位置完全交给浏览器控制。
  // 目标区块取自锚点自身的 href（#features 等）
  const handleAnchorClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault()
      setMobileMenuOpen(false)
      const id = event.currentTarget.hash.replace("#", "")
      const el = document.getElementById(id)
      if (!el) return

      // 全屏区块顶格停靠（导航是悬浮胶囊，直接盖在区块上）
      const targetY = Math.max(
        0,
        el.getBoundingClientRect().top + window.scrollY,
      )
      cancelScrollAnimation()
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches
      if (reduceMotion) {
        window.scrollTo(0, targetY)
        return
      }

      const startY = window.scrollY
      const distance = targetY - startY
      if (distance === 0) return
      const duration = Math.min(900, 400 + Math.abs(distance) * 0.25)
      const startTime = performance.now()
      // easeInOutCubic
      const ease = (t: number) =>
        t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

      const step = (now: number) => {
        const progress = Math.min(1, (now - startTime) / duration)
        window.scrollTo(0, startY + distance * ease(progress))
        scrollRafRef.current =
          progress < 1 ? requestAnimationFrame(step) : null
      }
      scrollRafRef.current = requestAnimationFrame(step)
    },
    [cancelScrollAnimation],
  )

  const navLinkClass = (id: string) =>
    cn(
      "rounded-full px-3 py-2 font-sans text-sm font-medium transition-colors",
      activeId === id
        ? "bg-white/10 text-white"
        : "text-white/70 hover:text-white",
    )

  return (
    <div className="min-h-screen w-full bg-neutral-950 font-sans">
      {/* 吸顶导航 */}
      <header className="fixed inset-x-0 top-0 z-50 pt-4">
        <div className="mx-6 flex items-center justify-between">
          <a
            href="#home"
            onClick={handleAnchorClick}
            aria-label="返回首页"
            className="inline-flex h-[40px] w-[100px] items-center justify-center rounded bg-center bg-cover"
            style={{ backgroundImage: `url(${LOGO_URL})` }}
          />

          <nav className="hidden items-center gap-2 md:flex">
            <div className="flex items-center gap-1 rounded-full bg-white/5 px-1 py-1 ring-1 ring-white/10 backdrop-blur">
              {NAV_LINKS.map((link) => (
                <a
                  key={link.id}
                  href={`#${link.id}`}
                  onClick={handleAnchorClick}
                  className={navLinkClass(link.id)}
                >
                  {link.label}
                </a>
              ))}
              <a
                href="/login"
                className="ml-1 inline-flex items-center gap-2 rounded-full bg-white px-3.5 py-2 font-sans text-sm font-medium text-neutral-900 transition-colors hover:bg-white/90"
              >
                登录
                <ArrowUpRight className="h-4 w-4" />
              </a>
            </div>
          </nav>

          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15 backdrop-blur md:hidden"
            aria-expanded={mobileMenuOpen}
            aria-label="切换菜单"
          >
            {mobileMenuOpen ? (
              <X className="h-5 w-5 text-white/90" />
            ) : (
              <Menu className="h-5 w-5 text-white/90" />
            )}
          </button>
        </div>

        {mobileMenuOpen && (
          <div className="mx-6 mt-2 rounded-2xl bg-neutral-950/90 p-2 ring-1 ring-white/10 backdrop-blur md:hidden">
            {NAV_LINKS.map((link) => (
              <a
                key={link.id}
                href={`#${link.id}`}
                onClick={handleAnchorClick}
                className={cn(
                  "block rounded-xl px-4 py-3 text-sm font-medium transition-colors",
                  activeId === link.id
                    ? "bg-white/10 text-white"
                    : "text-white/70 hover:text-white",
                )}
              >
                {link.label}
              </a>
            ))}
            <a
              href="/login"
              className="mt-1 flex items-center justify-between rounded-xl bg-white px-4 py-3 text-sm font-medium text-neutral-900"
            >
              登录
              <ArrowUpRight className="h-4 w-4" />
            </a>
          </div>
        )}
      </header>

      {/* 首页：欢迎 Hero */}
      <section
        id="home"
        className="relative isolate min-h-screen w-full overflow-hidden"
      >
        <img
          src={BACKGROUND_IMAGE_URL}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="pointer-events-none absolute inset-0 ring-1 ring-black/30" />

        <div className="relative z-10">
          <div className="mx-auto max-w-7xl px-6 pb-16 pt-36 sm:pt-36 md:pt-40 lg:pt-48">
            <div className="mx-auto max-w-3xl text-center">
              <div className="animate-fade-slide-in-1 mb-6 inline-flex items-center gap-3 rounded-full bg-white/10 px-2.5 py-2 ring-1 ring-white/15 backdrop-blur">
                <span className="inline-flex items-center rounded-full bg-white/90 px-2 py-0.5 font-sans text-xs font-medium text-neutral-900">
                  全新
                </span>
                <span className="font-sans text-sm font-medium text-white/90">
                  AI 智能图像生成平台正式上线
                </span>
              </div>

              <h1 className="animate-fade-slide-in-2 mt-6 text-4xl leading-tight font-normal tracking-tight text-white font-instrument-serif sm:text-5xl md:text-6xl lg:text-7xl">
                超越想象
                <br className="hidden sm:block" />
                智绘万千视觉
              </h1>

              <p className="animate-fade-slide-in-3 mx-auto mt-6 max-w-2xl text-base text-white/80 sm:text-lg">
                瀚星 Super Image
                汇聚前沿 AI 生成能力，让专业级图像创作触手可及。输入一句话，即可获得商用级画质，安全、高效、灵感无限。
              </p>

              <div className="animate-fade-slide-in-4 mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
                <a
                  href="/login"
                  className="inline-flex items-center gap-2 rounded-full bg-white/10 py-3 pr-5 pl-5 text-sm font-medium text-white ring-1 ring-white/15 transition-colors hover:bg-white/15"
                >
                  立即开始创作
                  <ArrowRight className="h-4 w-4" />
                </a>
                <a
                  href="#features"
                  onClick={handleAnchorClick}
                  className="inline-flex items-center gap-2 rounded-full bg-transparent px-5 py-3 text-sm font-medium text-white/90 transition-colors hover:text-white"
                >
                  观看演示
                </a>
              </div>
            </div>

            <div className="mx-auto mt-20 max-w-5xl">
              <p className="animate-fade-slide-in-1 text-center text-sm text-white/70">
                与全球领先创意机构与团队携手同行
              </p>
              <div className="animate-fade-slide-in-2 mt-6 grid grid-cols-2 items-center justify-items-center gap-4 text-white/70 sm:grid-cols-3 md:grid-cols-5">
                {PARTNERS.map((logoUrl) => (
                  <a
                    key={logoUrl}
                    href="#"
                    className="inline-flex h-[36px] w-[120px] items-center justify-center rounded-full bg-center bg-cover opacity-80 transition-opacity hover:opacity-100"
                    style={{ backgroundImage: `url(${logoUrl})` }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 产品功能：超空间星空（星空画布 + 功能文案） */}
      <StarfieldSection />

      {/* 订阅套餐：三档定价（月付/年付切换 + 热门流光卡） */}
      <section id="pricing" className="bg-neutral-950 px-6 py-24">
        <PricingSection
          plans={PLANS}
          heading="订阅套餐"
          description="按月或按年订阅，积分随套餐规模提升，随时升级降级，无隐藏费用。"
        />
      </section>

      {/* 用户评价：双行反向跑马灯（21st.dev 模板改造，内容为占位数据）。
          min-h-screen 保证锚点停靠时整屏被评价区占满，不露出下方帮助中心 */}
      <section
        id="testimonials"
        className="flex min-h-screen flex-col justify-center bg-neutral-950 px-6 py-24"
      >
        <TestimonialsSection
          heading="用户评价"
          description="来自设计、电商、内容创作团队的真实反馈，看看他们如何用瀚星 Super Image 提升创作效率。"
        />
      </section>

      {/* 帮助中心：分类 FAQ（标签切换 + 手风琴）。overflow-hidden 裁剪标题
          区向上溢出的模糊光晕 */}
      <section
        id="help"
        className="overflow-hidden bg-neutral-950 px-6 py-24"
      >
        <FaqSection
          heading="帮助中心"
          subtitle="常见问题解答"
          description="关于账号、积分、图像生成与样机渲染的常见问题。如果没有找到答案，请联系客服获取帮助。"
        />
      </section>

      {/* 页脚：圆角卡片 + 品牌区与四列链接（模板改写），左右与底部留出呼吸空间 */}
      <div className="bg-neutral-950 px-6 pb-12">
        <FooterSection logoUrl={LOGO_URL} onAnchorClick={handleAnchorClick} />
      </div>
    </div>
  )
}
