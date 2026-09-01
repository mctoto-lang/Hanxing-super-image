import type { ModelSizePreset } from "@/db/schema"

/**
 * 图片尺寸预设（自由创作页 §6 + 批量生图 / 商品主图共享）
 *
 * value = "{width}x{height}"（px），与 DB imageSize 字段格式一致。
 * 结构化预设（ModelSizePreset）来自各模型配置；空则回退 DEFAULT_SIZE_PRESETS。
 */
export interface SizePreset {
  value: string
  label: string
  /** 宽高比 W/H，用于绘制比例示意图标 */
  width: number
  height: number
  /** 该比例是否启用（后台开关）。false 时创作页置灰不可选，且不计入提交白名单 */
  enabled: boolean
}

/**
 * 默认尺寸预设（参考图2 的实际比例）。
 * 新建模型时默认填充；管理员可在表单中自由编辑增删。
 *
 * 注：参考图中的「智能」属"自动"模式，无确定实际比例/尺寸，与本系统
 * 「每项需配置实际比例 + 实际尺寸」的约束不符，故不纳入默认；如需要可由
 * 管理员手动新增。每个预设的 value（WxH）必须唯一，避免选择器 key 冲突。
 */
export const DEFAULT_SIZE_PRESETS: ModelSizePreset[] = [
  { label: "1:1", width: 1024, height: 1024, enabled: true },
  { label: "21:9", width: 1344, height: 576, enabled: true },
  { label: "16:9", width: 1280, height: 720, enabled: true },
  { label: "3:2", width: 1536, height: 1024, enabled: true },
  { label: "4:3", width: 1024, height: 768, enabled: true },
  { label: "3:4", width: 768, height: 1024, enabled: true },
  { label: "2:3", width: 1024, height: 1536, enabled: true },
  { label: "9:16", width: 720, height: 1280, enabled: true },
]

/**
 * 把模型的 sizePresets 解析为选择器可用的 SizePreset[]；
 * 空或非法则回退 DEFAULT_SIZE_PRESETS。
 *
 * 相同 value（WxH）只保留首个，避免列表 key 冲突 / 重复高亮
 * （防御管理员配置出重复尺寸）。
 *
 * opts.includeDisabled（默认 false）：是否保留被关闭(enabled=false)的项。
 * - false（默认，workspace/product 用）：过滤掉 disabled，仅返回可选项。
 * - true（创作页用）：保留 disabled 项，由前端置灰不可选地展示。
 *
 * 注意：仅当原始列表 null/空/全非法时才回退默认；"全部被关闭"不回退
 * （否则会误显全部启用）。
 */
export function resolveSizePresets(
  sizePresets: ModelSizePreset[] | null | undefined,
  opts?: { includeDisabled?: boolean },
): SizePreset[] {
  const includeDisabled = opts?.includeDisabled ?? false
  if (!sizePresets || sizePresets.length === 0) {
    return DEFAULT_SIZE_PRESETS.map(toSizePreset)
  }
  const mapped = sizePresets
    .filter(
      (s) =>
        s &&
        Number(s.width) > 0 &&
        Number(s.height) > 0 &&
        typeof s.label === "string",
    )
    .map(toSizePreset)
  const seen = new Set<string>()
  const unique = mapped.filter((s) => {
    if (seen.has(s.value)) return false
    seen.add(s.value)
    return true
  })
  if (unique.length === 0) return DEFAULT_SIZE_PRESETS.map(toSizePreset)
  return includeDisabled ? unique : unique.filter((s) => s.enabled)
}

function toSizePreset(s: ModelSizePreset): SizePreset {
  const width = Number(s.width)
  const height = Number(s.height)
  return {
    value: `${width}x${height}`,
    label: s.label?.trim() || `${width}x${height}`,
    width,
    height,
    enabled: s.enabled !== false,
  }
}

/**
 * 解析 "1024x1024" → { width: 1024, height: 1024 }，非法返回 1:1。
 */
export function parseImageSize(
  size: string | null | undefined,
): { width: number; height: number } {
  if (!size) return { width: 1, height: 1 }
  const m = size.match(/^(\d+)\s*[x×]\s*(\d+)$/i)
  if (!m) return { width: 1, height: 1 }
  return { width: Number(m[1]), height: Number(m[2]) }
}

/**
 * 从宽高计算最简比例字符串（如 16:9），用于详情展示。
 *
 * 大数字退化处理：当最简比任一边超过 20（如 561:701 互质约不掉）时，
 * 匹配最接近的常用比例（1:1 / 4:3 / 3:4 / 16:9 / 9:16 / 4:5 / 5:4 /
 * 3:2 / 2:3 / 21:9），偏差 ≤ 5% 内直接归一；找不到则回退尺寸式 `561×701`。
 */
export function sizeToRatioLabel(size: string | null | undefined): string {
  const { width, height } = parseImageSize(size)
  if (width <= 0 || height <= 0) return "—"
  const g = gcd(width, height)
  const rw = width / g
  const rh = height / g
  if (rw <= 20 && rh <= 20) return `${rw}:${rh}`

  // 常用比例表（宽高数值，用于比值匹配）
  const COMMON: Array<[number, number]> = [
    [1, 1],
    [4, 3],
    [3, 4],
    [16, 9],
    [9, 16],
    [4, 5],
    [5, 4],
    [3, 2],
    [2, 3],
    [21, 9],
  ]
  const target = width / height
  let best: [number, number] | null = null
  let bestDiff = Infinity
  for (const [cw, ch] of COMMON) {
    const diff = Math.abs(cw / ch - target) / (cw / ch)
    if (diff < bestDiff) {
      bestDiff = diff
      best = [cw, ch]
    }
  }
  // 偏差 ≤ 5% 采用近似常用比例，否则回退「宽×高」尺寸式
  return best && bestDiff <= 0.05
    ? `${best[0]}:${best[1]}`
    : `${width}×${height}`
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}
