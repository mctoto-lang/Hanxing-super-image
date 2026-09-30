import path from "node:path"
import fs from "node:fs"
import { createRequire } from "node:module"
import { getStorage } from "@/lib/storage"

/**
 * Agent 固定资产工具（服务端专用）
 *
 * 卡牌生成流水线的固定资产（kind 见 AGENT_ASSET_KINDS）：
 * - border / back：卡面级资产。border 是透明 PNG 边框参考图，最终卡图由 AI 融合生成；
 * - box_front / box_back / box_side / box_top：牌盒四面资产，作为参考图传给
 *   生图 API 生成实体牌盒样机（orderBoxAssets 固定引用顺序：正面在前）。
 *
 * PNG alpha 校验依赖 sharp 的惰性加载；AI 融合本身由上游生图模型完成。
 * sharp 惰性加载（loadSharp）：sharp 目前只是 next 的 optionalDependency
 * （pnpm 隔离布局下项目根 node_modules 无其软链，应用代码里的 `import "sharp"`
 * 既过不了 typecheck、运行时也找不到模块），故用 createRequire 双锚点解析：
 *   1. 以项目根 package.json 为锚的常规解析（sharp 未来成为直接依赖即命中）；
 *   2. 以 node_modules/next 的 realpath 为锚（pnpm 布局下 sharp 与 next 同层，
 *      realpath 穿透软链后 Node 的逐级向上查找必然经过该层）。
 * 加载失败返回 null 并一次性告警；Alpha 校验返回结构化结果，AI 融合由上游生图模型完成。
 */

/* ─── 资产种类 ────────────────────────────────────────────────────────── */

/** Agent 固定资产种类（卡面边框 / 卡背 / 牌盒四面） */
export const AGENT_ASSET_KINDS = [
  "border",
  "back",
  "box_front",
  "box_back",
  "box_side",
  "box_top",
] as const

export type AgentAssetKind = (typeof AGENT_ASSET_KINDS)[number]

/** 资产所属组：卡面参考图或牌盒参考图 */
export type AgentAssetGroup = "card" | "box"

export interface AgentAssetKindMeta {
  key: AgentAssetKind
  /** 中文名（日志/运行详情展示用） */
  name: string
  group: AgentAssetGroup
  /**
   * 是否要求透明底（PNG alpha）：边框是 overlay 合成的蒙层，必须透明底；
   * 其余为整幅画面资产，不强制。
   */
  requiresAlpha: boolean
  description: string
}

export const AGENT_ASSET_KIND_META: Record<AgentAssetKind, AgentAssetKindMeta> =
  {
    border: {
      key: "border",
      name: "卡面边框",
      group: "card",
      requiresAlpha: true,
      description: "透明 PNG 边框参考图，作为 AI 融合的第一张参考图",
    },
    back: {
      key: "back",
      name: "卡背",
      group: "card",
      requiresAlpha: false,
      description: "整套卡牌共用的背面整幅画面",
    },
    box_front: {
      key: "box_front",
      name: "牌盒正面",
      group: "box",
      requiresAlpha: false,
      description: "实体牌盒正面（主视觉面），参考图引用顺序第一位",
    },
    box_back: {
      key: "box_back",
      name: "牌盒背面",
      group: "box",
      requiresAlpha: false,
      description: "实体牌盒背面",
    },
    box_side: {
      key: "box_side",
      name: "牌盒侧面",
      group: "box",
      requiresAlpha: false,
      description: "实体牌盒侧面（窄边）",
    },
    box_top: {
      key: "box_top",
      name: "牌盒顶面",
      group: "box",
      requiresAlpha: false,
      description: "实体牌盒顶面/底面",
    },
  }

/** 卡面级资产 kinds（border / card_back） */
export const AGENT_CARD_ASSET_KINDS = AGENT_ASSET_KINDS.filter(
  (k) => AGENT_ASSET_KIND_META[k].group === "card",
)

/** 牌盒级资产 kinds（box_*） */
export const AGENT_BOX_ASSET_KINDS = AGENT_ASSET_KINDS.filter(
  (k) => AGENT_ASSET_KIND_META[k].group === "box",
)

/** 值是否为合法资产 kind（jsonb 落库脏数据防御，同 storage config 惯例） */
export function isAgentAssetKind(value: unknown): value is AgentAssetKind {
  return (
    typeof value === "string" &&
    (AGENT_ASSET_KINDS as readonly string[]).includes(value)
  )
}

/* ─── 牌盒资产引用排序 ────────────────────────────────────────────────── */

/**
 * 牌盒四面作为生图参考图时的固定顺序：正面（主视觉）→ 背面 → 侧面 → 顶面。
 * 上游生图 API 对参考图顺序敏感（首位权重最高），必须以正面打头。
 */
export const BOX_ASSET_REFERENCE_ORDER = [
  "box_front",
  "box_back",
  "box_side",
  "box_top",
] as const

const BOX_ASSET_ORDER_INDEX = new Map<string, number>(
  BOX_ASSET_REFERENCE_ORDER.map((kind, i) => [kind, i]),
)

/**
 * 按固定顺序排牌盒资产（稳定排序：同 kind 与未登记 kind 保持原相对顺序，
 * 未登记 kind 排在已登记之后）。泛型保留元素上的其余字段（url 等）。
 */
export function orderBoxAssets<T extends { kind: string }>(
  assets: Iterable<T>,
): T[] {
  const indexed = Array.from(assets).map((asset, i) => ({
    asset,
    i,
    order: BOX_ASSET_ORDER_INDEX.get(asset.kind),
  }))
  indexed.sort((a, b) => {
    if (a.order !== undefined && b.order !== undefined) return a.order - b.order
    if (a.order !== undefined) return -1
    if (b.order !== undefined) return 1
    return a.i - b.i
  })
  return indexed.map((e) => e.asset)
}

/* ─── PNG alpha 校验（AI 融合前置校验）────────────────────────────────── */

/** sharp 元数据子集（本模块用到的字段） */
export interface SharpMetadata {
  format?: string
  width?: number
  height?: number
  hasAlpha?: boolean
}

export interface SharpInstance {
  metadata(): Promise<SharpMetadata>
  stats(): Promise<{ isOpaque?: boolean }>
  resize(
    width: number,
    height: number,
    options?: { fit?: "cover" | "fill" | "contain" },
  ): SharpInstance
  composite(images: Array<{ input: Buffer; blend?: string }>): SharpInstance
  png(options?: { compressionLevel?: number }): SharpInstance
  toBuffer(): Promise<Buffer>
}

export type SharpLike = (input?: Buffer | string) => SharpInstance

let sharpPromise: Promise<SharpLike | null> | null = null
let warnedUnavailable = false

/** 归一化 require 产物：兼容 CJS module.exports 与 ESM default 双形态 */
function normalizeSharpModule(mod: unknown): SharpLike | null {
  if (!mod) return null
  const candidate = mod as { default?: unknown }
  const sharp = candidate.default ?? mod
  if (typeof sharp !== "function") return null
  return sharp as SharpLike
}

/** 锚点 1：项目根常规解析（sharp 成为直接依赖 / hoist 时命中） */
function loadSharpFromProjectRoot(): SharpLike | null {
  try {
    const projectRequire = createRequire(path.join(process.cwd(), "package.json"))
    return normalizeSharpModule(projectRequire("sharp"))
  } catch {
    return null
  }
}

/**
 * 锚点 2：以 next 的 realpath 为锚（pnpm 隔离布局）。
 * node_modules/next 是指向 .pnpm/next@…/node_modules/next 的软链；sharp 作为
 * next 的 optionalDependency 链在同一层，realpath 后 Node 沿目录逐级向上
 * 查找 node_modules 必然命中该层。
 */
function loadSharpFromNext(): SharpLike | null {
  try {
    const nextRealDir = fs.realpathSync(
      path.join(process.cwd(), "node_modules", "next"),
    )
    const nextRequire = createRequire(path.join(nextRealDir, "package.json"))
    return normalizeSharpModule(nextRequire("sharp"))
  } catch {
    return null
  }
}

/**
 * 惰性加载 sharp（进程内缓存 Promise；失败也缓存，避免每次调用重复探测）。
 * 返回 null 表示当前环境 sharp 不可用，调用方按结构化结果降级。
 */
export function loadSharp(): Promise<SharpLike | null> {
  sharpPromise ??= (async () => {
    const sharp = loadSharpFromProjectRoot() ?? loadSharpFromNext()
    if (!sharp && !warnedUnavailable) {
      warnedUnavailable = true
      console.warn(
        "[agent/assets] sharp 不可用：PNG alpha 校验与边框合成将降级跳过" +
          "（可将 sharp 加入 package.json 直接依赖，或检查 node_modules 安装完整性）",
      )
    }
    return sharp
  })()
  return sharpPromise
}

/* ─── PNG alpha 校验 ──────────────────────────────────────────────────── */

export interface PngAlphaValidationOptions {
  /** 要求图片带 alpha 通道（默认 true；边框等 overlay 资产必须透明底） */
  requireAlpha?: boolean
  /** 拒绝「伪透明」PNG（有 alpha 通道但全不透明；默认 true） */
  rejectFullyOpaque?: boolean
}

export type PngAlphaValidation =
  | {
      ok: true
      width: number
      height: number
      hasAlpha: boolean
      /** alpha 通道全不透明（rejectFullyOpaque=false 时不拦截仅报告） */
      fullyOpaque: boolean
    }
  | {
      ok: false
      reason:
        | "sharp_unavailable"
        | "not_png"
        | "no_alpha"
        | "fully_opaque"
        | "missing_dimensions"
        | "invalid_image"
      error?: string
    }

/**
 * 校验 PNG 的 alpha 通道（资产入库/合成前的把关）。
 * sharp 不可用时返回 { ok: false, reason: "sharp_unavailable" }，不抛错。
 */
export async function validatePngAlpha(
  buffer: Buffer,
  opts: PngAlphaValidationOptions = {},
): Promise<PngAlphaValidation> {
  const { requireAlpha = true, rejectFullyOpaque = true } = opts
  const sharp = await loadSharp()
  if (!sharp) return { ok: false, reason: "sharp_unavailable" }

  try {
    const meta = await sharp(buffer).metadata()
    const format = (meta.format ?? "").toLowerCase()
    if (format !== "png") {
      return { ok: false, reason: "not_png", error: `format=${format || "unknown"}` }
    }
    if (!meta.width || !meta.height) {
      return { ok: false, reason: "missing_dimensions" }
    }
    if (requireAlpha && meta.hasAlpha !== true) {
      return { ok: false, reason: "no_alpha" }
    }

    // 全不透明检测：仅当确有 alpha 通道时才视为「伪透明」
    // （stats 失败不拦截——校验以 metadata 为准，降级放行）
    let fullyOpaque = false
    try {
      const stats = await sharp(buffer).stats()
      fullyOpaque = meta.hasAlpha === true && stats.isOpaque === true
    } catch {
      fullyOpaque = false
    }
    if (rejectFullyOpaque && fullyOpaque) {
      return { ok: false, reason: "fully_opaque", error: "alpha 通道全不透明" }
    }

    return {
      ok: true,
      width: meta.width,
      height: meta.height,
      hasAlpha: meta.hasAlpha === true,
      fullyOpaque,
    }
  } catch (err) {
    return {
      ok: false,
      reason: "invalid_image",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** 按资产 kind 的透明度要求校验（kind → requireAlpha 取 META 配置） */
export function validateAgentAsset(
  buffer: Buffer,
  kind: AgentAssetKind,
): Promise<PngAlphaValidation> {
  return validatePngAlpha(buffer, {
    requireAlpha: AGENT_ASSET_KIND_META[kind].requiresAlpha,
  })
}

/* ─── 入库（复用统一存储接口） ─────────────────────────────────────────── */

/**
 * Agent 固定资产入库：复用统一存储接口（本地/COS 按 system_setting 切换），
 * 统一 PNG 扩展名与 generate 分类（AI 产物，随生命周期过期清理），与
 * 编排引擎转存生图结果的 category 一致。
 */
export async function saveAgentAsset(
  buffer: Buffer,
  enterpriseId: string,
): Promise<string> {
  const storage = await getStorage()
  return storage.saveFromBuffer(buffer, enterpriseId, "png", "generate")
}
