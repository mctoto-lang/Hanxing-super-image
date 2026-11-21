"use client"

import * as React from "react"
import { Icon } from "@iconify/react"
import amazonIcon from "@iconify-icons/selfhst/amazon"
import temuIcon from "@iconify-icons/selfhst/temu"
import {
  SiEtsy,
  SiFacebook,
  SiInstagram,
  SiPinterest,
  SiReddit,
  SiShopify,
  SiTiktok,
  SiX,
} from "@icons-pack/react-simple-icons"
import { countryLabel, type SelectionPlatform } from "@/lib/selection/platforms"
import { platformLabel } from "./labels"

/**
 * 选品工具平台 logo + 国旗徽标（卡片/筛选栏/详情弹窗共用）
 *
 * 图标来源：@icons-pack/react-simple-icons（官方品牌色）+ @iconify-icons/
 * selfhst（Amazon/TEMU，simple-icons 无此二标）。深色徽章上统一垫白色小
 * 圆角底片保证黑底图标（X/TikTok）与深色主题可见性。
 * 国旗：Windows Chrome 不渲染国旗 emoji，内置 16×12 简化 SVG（12 国），
 * 未知码回退灰底 Globe。
 */

const PLATFORM_ICON_COLOR: Partial<Record<SelectionPlatform, string>> = {
  etsy: "#F1641E",
  shopify: "#95BF47",
  instagram: "#E4405F",
  tiktok: "#010101",
  pinterest: "#BD081C",
  reddit: "#FF4500",
  x: "#000000",
  facebook: "#1877F2",
}

/** 平台 logo（无库图标时回退文本首字母） */
export function PlatformLogo({
  platform,
  size = 14,
}: {
  platform: string
  size?: number
}) {
  const s = { width: size, height: size }
  switch (platform) {
    case "amazon":
      return <Icon icon={amazonIcon} {...s} aria-hidden />
    case "temu":
      return <Icon icon={temuIcon} {...s} aria-hidden />
    case "etsy":
      return <SiEtsy {...s} color={PLATFORM_ICON_COLOR.etsy} aria-hidden />
    case "shopify":
      return <SiShopify {...s} color={PLATFORM_ICON_COLOR.shopify} aria-hidden />
    case "instagram":
      return <SiInstagram {...s} color={PLATFORM_ICON_COLOR.instagram} aria-hidden />
    case "tiktok":
      return <SiTiktok {...s} color={PLATFORM_ICON_COLOR.tiktok} aria-hidden />
    case "pinterest":
      return <SiPinterest {...s} color={PLATFORM_ICON_COLOR.pinterest} aria-hidden />
    case "reddit":
      return <SiReddit {...s} color={PLATFORM_ICON_COLOR.reddit} aria-hidden />
    case "x":
      return <SiX {...s} color={PLATFORM_ICON_COLOR.x} aria-hidden />
    case "facebook":
      return <SiFacebook {...s} color={PLATFORM_ICON_COLOR.facebook} aria-hidden />
    default:
      return (
        <span
          className="inline-flex items-center justify-center rounded-sm bg-muted text-[8px] font-bold text-muted-foreground"
          style={{ width: size, height: size }}
          aria-hidden
        >
          {platform.slice(0, 1).toUpperCase()}
        </span>
      )
  }
}

/**
 * 徽章内 logo：彩色品牌 logo 直接裸放（黑底徽章上清晰）；仅黑/近黑品牌色
 * （X、TikTok）保留白色小圆片垫层保证可见性。
 */
const DARK_LOGO_PLATFORMS = new Set(["x", "tiktok"])

function LogoChip({ platform, size = 14 }: { platform: string; size?: number }) {
  if (!DARK_LOGO_PLATFORMS.has(platform)) {
    return <PlatformLogo platform={platform} size={size} />
  }
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-[3px] bg-white p-[2px] leading-none shadow-sm">
      <PlatformLogo platform={platform} size={size} />
    </span>
  )
}

// ── 国旗（16×12 简化 SVG；色块/条纹近似官方比例） ────────────────

function V3({ a, b, c }: { a: string; b: string; c: string }) {
  return (
    <>
      <rect width="5.34" height="12" fill={a} />
      <rect x="5.34" width="5.34" height="12" fill={b} />
      <rect x="10.68" width="5.32" height="12" fill={c} />
    </>
  )
}
function H3({ a, b, c, ratio = 3 }: { a: string; b: string; c: string; ratio?: number }) {
  const outer = 12 / ratio
  return (
    <>
      <rect width="16" height={outer} fill={a} />
      <rect y={outer} width="16" height={12 - outer * 2} fill={b} />
      <rect y={12 - outer} width="16" height={outer} fill={c} />
    </>
  )
}

const FLAG_SHAPES: Record<string, React.ReactNode> = {
  US: (
    <>
      <rect width="16" height="12" fill="#B22234" />
      {[1, 3, 5, 7, 9, 11].map((y) => (
        <rect key={y} y={y} width="16" height="1" fill="#fff" />
      ))}
      <rect width="7" height="7" fill="#3C3B6E" />
    </>
  ),
  GB: (
    <>
      <rect width="16" height="12" fill="#012169" />
      <path d="M0 0 L16 12 M16 0 L0 12" stroke="#fff" strokeWidth="2.4" />
      <path d="M0 0 L16 12 M16 0 L0 12" stroke="#C8102E" strokeWidth="1" />
      <path d="M8 0 V12 M0 6 H16" stroke="#fff" strokeWidth="3.6" />
      <path d="M8 0 V12 M0 6 H16" stroke="#C8102E" strokeWidth="2" />
    </>
  ),
  CA: (
    <>
      <rect width="16" height="12" fill="#fff" />
      <rect width="4" height="12" fill="#D80621" />
      <rect x="12" width="4" height="12" fill="#D80621" />
    </>
  ),
  AU: (
    <>
      <rect width="16" height="12" fill="#012169" />
      <path d="M0 0 L7 5.25 M7 0 L0 5.25" stroke="#fff" strokeWidth="1.4" />
      <path d="M0 0 L7 5.25 M7 0 L0 5.25" stroke="#C8102E" strokeWidth="0.6" />
      <path d="M3.5 0 V5.25 M0 2.625 H7" stroke="#fff" strokeWidth="1.8" />
      <path d="M3.5 0 V5.25 M0 2.625 H7" stroke="#C8102E" strokeWidth="1" />
      <circle cx="12" cy="8.5" r="1" fill="#fff" />
      <circle cx="10" cy="6" r="0.5" fill="#fff" />
    </>
  ),
  DE: <H3 a="#000" b="#DD0000" c="#FFCE00" />,
  FR: <V3 a="#002395" b="#fff" c="#ED2939" />,
  IT: <V3 a="#009246" b="#fff" c="#CE2B37" />,
  ES: <H3 a="#AA151B" b="#F1BF00" c="#AA151B" ratio={4} />,
  JP: (
    <>
      <rect width="16" height="12" fill="#fff" />
      <circle cx="8" cy="6" r="3.2" fill="#BC002D" />
    </>
  ),
  MX: (
    <>
      <V3 a="#006847" b="#fff" c="#CE1126" />
      <circle cx="8" cy="6" r="1.2" fill="#8C6A47" />
    </>
  ),
  BR: (
    <>
      <rect width="16" height="12" fill="#009B3A" />
      <path d="M8 1.5 L14.5 6 L8 10.5 L1.5 6 Z" fill="#FEDF00" />
      <circle cx="8" cy="6" r="2.2" fill="#002776" />
    </>
  ),
}
FLAG_SHAPES.UK = FLAG_SHAPES.GB

/** 国旗（未知码回退灰底 Globe 圆点） */
export function CountryFlag({ code, size = 14 }: { code: string | null | undefined; size?: number }) {
  const upper = code?.toUpperCase()
  const shape = upper ? FLAG_SHAPES[upper] : null
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[2px] leading-none"
      style={{ width: Math.round(size * 4 / 3), height: size }}
      title={upper ? countryLabel(upper) : undefined}
    >
      {shape ? (
        <svg viewBox="0 0 16 12" width="100%" height="100%" aria-hidden>
          {shape}
        </svg>
      ) : (
        <span className="h-full w-full bg-muted" aria-hidden />
      )}
    </span>
  )
}

/**
 * 卡片左上角徽章组：[logo+平台名] [国旗+国家码]（黑底白字，与现有卡片
 * 徽章同款样式；无国家时只显平台段）。
 */
export function PlatformCountryBadge({
  platform,
  country,
}: {
  platform: string
  country?: string | null
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="flex items-center gap-1 rounded-sm bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
        <LogoChip platform={platform} size={11} />
        {platformLabel(platform)}
      </span>
      {country ? (
        <span className="flex items-center gap-1 rounded-sm bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
          <CountryFlag code={country} size={10} />
          {country}
        </span>
      ) : null}
    </div>
  )
}

/** 筛选栏/表格用内联版：logo + 名称（无底片，浅色背景友好） */
export function PlatformInlineIcon({
  platform,
  size = 14,
}: {
  platform: string
  size?: number
}) {
  return (
    <span className="inline-flex items-center gap-1.5 leading-none">
      <PlatformLogo platform={platform} size={size} />
    </span>
  )
}
