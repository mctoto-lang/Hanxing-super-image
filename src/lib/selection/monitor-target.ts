import { AMAZON_SITE_DOMAINS, canonicalAmazonUrl, type AmazonSite } from "./amazon-lists"
import type { SelectionPlatform } from "./platforms"

/**
 * 监控目标链接解析（client-safe）：粘贴商品 / 帖子链接 → 平台 + 规范链接 + 平台 ID
 *
 * 「添加监控」弹窗与服务端共用：域名判平台、路径抽平台 ID、去追踪参数生成规范链接。
 * 仅收录可直抓入口的平台（与注册表 monitor 配置一致）；Shopify 商品页无固定域名
 * 特征，只能从选品发现卡片加入。
 */

export interface MonitorTarget {
  platform: SelectionPlatform
  /** 规范化后的目标链接（去追踪参数，作 actor 入参与唯一键） */
  url: string
  /** 平台原生 ID（ASIN / goodsId / 帖子 ID…） */
  externalId: string | null
  /** 站点 / 国家（ISO 码；无国家概念的平台 null） */
  country: string | null
}

export type MonitorTargetResult =
  | { ok: true; target: MonitorTarget }
  | { ok: false; error: string }

const UNSUPPORTED_HOST = `无法识别该链接所属平台。支持粘贴 Amazon、Etsy、TEMU、Instagram、TikTok、Pinterest、Reddit、X、Facebook 的商品 / 帖子链接；Shopify 商品请从选品发现卡片加入监控`

function parseUrl(raw: string): URL | null {
  const s = raw.trim()
  if (!s) return null
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
  } catch {
    return null
  }
}

/** 去 www. 前缀的主机名 */
function bareHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "")
}

function amazonSiteOfHost(host: string): AmazonSite | null {
  const h = host.replace(/^smile\./, "")
  return (Object.keys(AMAZON_SITE_DOMAINS) as AmazonSite[]).find(
    (s) => AMAZON_SITE_DOMAINS[s] === h,
  ) ?? null
}

/** 从 TEMU 链接抽 goodsId（?goods_id=，或 …-g-<id>.html / …-g<id>.html 两种路径形态） */
export function temuGoodsIdFromUrl(url: string): string | null {
  const m = url.match(/[?&]goods_id=(\d{6,})/) ?? url.match(/-g-?(\d{6,})\.html/i)
  return m ? m[1]! : null
}

/** TEMU 规范商品链接（去 _bg_fs / 追踪参数）；解析不出返回 null */
export function canonicalTemuUrl(urlOrId: string | null | undefined): string | null {
  if (!urlOrId) return null
  const id = /^\d{6,}$/.test(urlOrId.trim())
    ? urlOrId.trim()
    : temuGoodsIdFromUrl(urlOrId)
  return id ? `https://www.temu.com/goods.html?goods_id=${id}` : null
}

const RULES: Array<{
  platform: SelectionPlatform
  match: (url: URL, host: string) => MonitorTarget | null
}> = [
  {
    platform: "amazon",
    match: (_url, host) => {
      const site = amazonSiteOfHost(host)
      if (!site) return null
      const asin = _url.pathname.match(/\/(?:dp|gp\/product|exec\/obidos)\/([A-Z0-9]{10})(?:[/?#]|$)/i)?.[1]
      if (!asin) {
        throw new Error("Amazon 链接里找不到商品 ASIN，请粘贴商品详情页链接（含 /dp/ASIN）")
      }
      return {
        platform: "amazon",
        url: canonicalAmazonUrl({ asin: asin.toUpperCase(), site })!,
        externalId: asin.toUpperCase(),
        country: site,
      }
    },
  },
  {
    platform: "etsy",
    match: (url, host) => {
      if (host !== "etsy.com") return null
      const id = url.pathname.match(/\/listing\/(\d+)/)?.[1]
      if (!id) throw new Error("Etsy 链接里找不到商品编号，请粘贴商品详情页链接")
      return {
        platform: "etsy",
        url: `https://www.etsy.com/listing/${id}`,
        externalId: id,
        country: null,
      }
    },
  },
  {
    platform: "temu",
    match: (_url, host) => {
      if (host !== "temu.com") return null
      const id = temuGoodsIdFromUrl(_url.href)
      if (!id) throw new Error("TEMU 链接里找不到商品 ID，请粘贴商品详情页链接")
      return {
        platform: "temu",
        url: canonicalTemuUrl(id)!,
        externalId: id,
        country: "US",
      }
    },
  },
  {
    platform: "instagram",
    match: (url, host) => {
      if (host !== "instagram.com") return null
      const m = url.pathname.match(/^\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)
      if (!m) throw new Error("Instagram 链接里找不到帖子短码，请粘贴单条帖子链接")
      return {
        platform: "instagram",
        url: `https://www.instagram.com/p/${m[1]}/`,
        externalId: m[1]!,
        country: null,
      }
    },
  },
  {
    platform: "tiktok",
    match: (url, host) => {
      if (host !== "tiktok.com") return null
      const m = url.pathname.match(/^\/@([^/]+)\/(video|photo)\/(\d+)/)
      if (!m) throw new Error("TikTok 链接里找不到视频 ID，请粘贴单条视频链接")
      return {
        platform: "tiktok",
        url: `https://www.tiktok.com/@${m[1]}/${m[2]}/${m[3]}`,
        externalId: m[3]!,
        country: null,
      }
    },
  },
  {
    platform: "pinterest",
    match: (url, host) => {
      if (host === "pin.it") throw new Error("pin.it 短链无法解析，请粘贴浏览器地址栏里的完整 Pin 链接")
      if (!/(^|\.)pinterest\.[a-z.]+$/.test(host)) return null
      const id = url.pathname.match(/^\/pin\/([A-Za-z0-9_-]+)/)?.[1]
      if (!id) throw new Error("Pinterest 链接里找不到 Pin ID，请粘贴单个 Pin 的链接")
      return {
        platform: "pinterest",
        url: `https://www.pinterest.com/pin/${id}/`,
        externalId: id,
        country: null,
      }
    },
  },
  {
    platform: "reddit",
    match: (url, host) => {
      if (!/(^|\.)reddit\.com$/.test(host)) return null
      const m = url.pathname.match(/^\/r\/([^/]+)\/comments\/([a-z0-9]+)/i)
      if (!m) throw new Error("Reddit 链接里找不到帖子 ID，请粘贴单个帖子的链接")
      return {
        platform: "reddit",
        url: `https://www.reddit.com/r/${m[1]}/comments/${m[2]}/`,
        externalId: m[2]!,
        country: null,
      }
    },
  },
  {
    platform: "x",
    match: (_url, host) => {
      if (host !== "x.com" && host !== "twitter.com") return null
      const m = _url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)/)
      if (!m) throw new Error("X 链接里找不到推文 ID，请粘贴单条推文链接")
      return {
        platform: "x",
        url: `https://x.com/${m[1]}/status/${m[2]}`,
        externalId: m[2]!,
        country: null,
      }
    },
  },
  {
    platform: "facebook",
    match: (url, host) => {
      if (!/(^|\.)facebook\.com$/.test(host) && host !== "fb.watch" && host !== "fb.com") return null
      // reel / videos / watch 的 ID 可直接定位；/share/ 短链无法解析
      const reel = url.pathname.match(/^\/(?:reel|reels)\/(\d+)/)
      const video = url.pathname.match(/^\/videos?\/(\d+)/)
      const watch = url.searchParams.get("v")
      const permalink = url.searchParams.get("permalink")
      const post = url.pathname.match(/^\/([^/]+)\/posts\/([A-Za-z0-9_]+)/)
      const share = url.pathname.match(/^\/share\/[a-z]\/([A-Za-z0-9]+)/i)
      const id = reel?.[1] ?? video?.[1] ?? watch ?? permalink ?? post?.[2] ?? null
      if (!id) {
        throw new Error(
          share ? "Facebook 分享短链无法解析，请粘贴帖子 / Reel 的完整链接" : "Facebook 链接里找不到帖子 ID",
        )
      }
      return {
        platform: "facebook",
        url: reel
          ? `https://www.facebook.com/reel/${id}`
          : video
            ? `https://www.facebook.com/videos/${id}`
            : permalink
              ? `https://www.facebook.com/permalink/?permalink=${encodeURIComponent(permalink)}`
              : post
                ? `https://www.facebook.com/${post[1]}/posts/${id}`
                : `https://www.facebook.com/watch/?v=${watch}`,
        externalId: /^\d+$/.test(id) ? id : null,
        country: null,
      }
    },
  },
]

/** 解析监控目标链接；任何平台都不命中返回 UNSUPPORTED_HOST */
export function resolveMonitorTarget(raw: string): MonitorTargetResult {
  const url = parseUrl(raw)
  if (!url) return { ok: false, error: "请输入有效的商品 / 帖子链接" }
  const host = bareHost(url)
  for (const rule of RULES) {
    try {
      const target = rule.match(url, host)
      if (target) return { ok: true, target }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "链接无法解析" }
    }
  }
  return { ok: false, error: UNSUPPORTED_HOST }
}

/** 可通过粘贴链接添加监控的平台（UI 提示文案用） */
export const MONITOR_URL_PLATFORMS: SelectionPlatform[] = [
  "amazon",
  "etsy",
  "temu",
  "instagram",
  "tiktok",
  "pinterest",
  "reddit",
  "x",
  "facebook",
]
