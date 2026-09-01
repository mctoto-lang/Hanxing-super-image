"use client"

import { useEffect, useRef, useState, type ComponentType, type MouseEvent } from "react"
import { cn } from "@/lib/utils"

/** lucide-react 1.x 已移除全部品牌图标，此处内联 simple-icons 官方路径替代 */
function BrandIcon({ path, className }: { path: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d={path} />
    </svg>
  )
}

const FacebookIcon = ({ className }: { className?: string }) => (
  <BrandIcon
    className={className}
    path="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"
  />
)

const InstagramIcon = ({ className }: { className?: string }) => (
  <BrandIcon
    className={className}
    path="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zM12 16c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"
  />
)

const YoutubeIcon = ({ className }: { className?: string }) => (
  <BrandIcon
    className={className}
    path="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"
  />
)

const LinkedinIcon = ({ className }: { className?: string }) => (
  <BrandIcon
    className={className}
    path="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"
  />
)

interface FooterLink {
  title: string
  /** 前缀为 # 的锚点链接由落地页导航的平滑滚动接管；"#" 为占位 */
  href: string
  icon?: ComponentType<{ className?: string }>
}

interface FooterSectionData {
  label: string
  links: FooterLink[]
}

const FOOTER_SECTIONS: FooterSectionData[] = [
  {
    label: "产品",
    links: [
      { title: "产品功能", href: "#features" },
      { title: "订阅套餐", href: "#pricing" },
      { title: "用户评价", href: "#testimonials" },
      { title: "帮助中心", href: "#help" },
    ],
  },
  {
    label: "公司",
    links: [
      { title: "关于我们", href: "#" },
      { title: "隐私政策", href: "#" },
      { title: "服务条款", href: "#" },
      { title: "联系我们", href: "#" },
    ],
  },
  {
    label: "资源",
    links: [
      { title: "使用教程", href: "#" },
      { title: "更新日志", href: "#" },
      { title: "常见问题", href: "#help" },
      { title: "开放 API", href: "#" },
    ],
  },
  {
    label: "社交媒体",
    links: [
      { title: "Facebook", href: "#", icon: FacebookIcon },
      { title: "Instagram", href: "#", icon: InstagramIcon },
      { title: "Youtube", href: "#", icon: YoutubeIcon },
      { title: "LinkedIn", href: "#", icon: LinkedinIcon },
    ],
  },
]

interface FooterSectionProps {
  logoUrl: string
  /** 锚点点击回调（落地页的 rAF 平滑滚动）；仅对 href 以 # 开头的链接生效 */
  onAnchorClick?: (event: MouseEvent<HTMLAnchorElement>) => void
}

/**
 * 营销落地页页脚：圆角卡片 + 顶部光晕 + 品牌区与四列链接。
 * 改编自 21st.dev footer-section 模板——motion/react 的 whileInView
 * 入场动画按项目惯例改写为 IntersectionObserver + CSS 过渡
 * （见 globals.css 的 .footer-reveal / .footer-in-view）。
 */
export default function FooterSection({ logoUrl, onAnchorClick }: FooterSectionProps) {
  const footerRef = useRef<HTMLElement>(null)
  const [inView, setInView] = useState(false)

  // 进入视口时触发各区块依次渐入（等效 motion 的 whileInView + once）
  useEffect(() => {
    const footer = footerRef.current
    if (!footer) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true)
          io.disconnect()
        }
      },
      { threshold: 0 },
    )
    io.observe(footer)
    return () => io.disconnect()
  }, [])

  return (
    <footer
      ref={footerRef}
      className={cn(
        "relative mx-auto flex w-full max-w-7xl flex-col items-center justify-center rounded-t-4xl border-t border-white/10 bg-[radial-gradient(35%_128px_at_50%_0%,rgba(255,255,255,0.08),transparent)] px-6 py-12 md:rounded-t-6xl lg:py-16",
        inView && "footer-in-view",
      )}
    >
      {/* 顶部中央模糊光缝 */}
      <div className="absolute top-0 right-1/2 left-1/2 h-px w-1/3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/20 blur" />

      <div className="grid w-full gap-8 xl:grid-cols-3 xl:gap-8">
        <div className="footer-reveal space-y-4" style={{ transitionDelay: "0.1s" }}>
          <a
            href="#home"
            onClick={onAnchorClick}
            aria-label="返回首页"
            className="inline-flex h-[32px] w-[80px] items-center justify-center rounded bg-center bg-cover opacity-90"
            style={{ backgroundImage: `url(${logoUrl})` }}
          />
          <p className="mt-8 text-sm text-white/60 md:mt-0">
            © {new Date().getFullYear()} 瀚星 Super Image. 保留所有权利。
          </p>
        </div>

        <div className="mt-10 grid grid-cols-2 gap-8 md:grid-cols-4 xl:col-span-2 xl:mt-0">
          {FOOTER_SECTIONS.map((section, index) => (
            <div
              key={section.label}
              className="footer-reveal"
              style={{ transitionDelay: `${0.2 + index * 0.1}s` }}
            >
              <div className="mb-10 md:mb-0">
                <h3 className="text-xs text-white/90">{section.label}</h3>
                <ul className="mt-4 space-y-2 text-sm text-white/60">
                  {section.links.map((link) => (
                    <li key={link.title}>
                      <a
                        href={link.href}
                        onClick={link.href.startsWith("#") ? onAnchorClick : undefined}
                        className="inline-flex items-center transition-colors duration-300 hover:text-white"
                      >
                        {link.icon && <link.icon className="me-1 size-4" />}
                        {link.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </div>
    </footer>
  )
}
