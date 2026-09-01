/**
 * AI换色取色换算（HEX / RGB / HSB / CMYK）
 *
 * HSB 为图像软件通行的色相/饱和度/明度模型（选色输入用）；
 * CMYK 仅作为旧提示词模板的兼容派生值（无 ICC Profile 的通用近似换算）。
 */

export interface RgbValue {
  r: number
  g: number
  b: number
}

export interface CmykValue {
  c: number
  m: number
  y: number
  k: number
}

/** HSB：h 0-360，s/b 0-100（图像软件通行的百分制） */
export interface HsbValue {
  h: number
  s: number
  b: number
}

/** "#1f2a44" / "1F2A44" → 合法 6 位大写 HEX；非法返回 null */
export function normalizeHex(hex: string): string | null {
  const trimmed = hex.trim().replace(/^#/, "")
  if (!/^[0-9a-fA-F]{6}$/.test(trimmed)) return null
  return `#${trimmed.toUpperCase()}`
}

export function hexToRgb(hex: string): RgbValue | null {
  const normalized = normalizeHex(hex)
  if (!normalized) return null
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  }
}

function clampByte(n: number): number {
  return Math.min(255, Math.max(0, Math.round(n)))
}

export function rgbToHex(rgb: RgbValue): string {
  const to2 = (n: number) => clampByte(n).toString(16).padStart(2, "0")
  return `#${to2(rgb.r)}${to2(rgb.g)}${to2(rgb.b)}`.toUpperCase()
}

/** RGB → CMYK（通用近似公式，K 先行法） */
export function rgbToCmyk(rgb: RgbValue): CmykValue {
  const r = clampByte(rgb.r) / 255
  const g = clampByte(rgb.g) / 255
  const b = clampByte(rgb.b) / 255
  const k = 1 - Math.max(r, g, b)
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 }
  return {
    c: Math.round(((1 - r - k) / (1 - k)) * 100),
    m: Math.round(((1 - g - k) / (1 - k)) * 100),
    y: Math.round(((1 - b - k) / (1 - k)) * 100),
    k: Math.round(k * 100),
  }
}

/** CMYK（百分比 0-100）→ RGB */
export function cmykToRgb(cmyk: CmykValue): RgbValue {
  const c = cmyk.c / 100
  const m = cmyk.m / 100
  const y = cmyk.y / 100
  const k = cmyk.k / 100
  return {
    r: clampByte(255 * (1 - c) * (1 - k)),
    g: clampByte(255 * (1 - m) * (1 - k)),
    b: clampByte(255 * (1 - y) * (1 - k)),
  }
}

/** 展示/注入用格式化（无空格紧凑格式） */
export function formatCmyk(cmyk: CmykValue): string {
  return `${cmyk.c},${cmyk.m},${cmyk.y},${cmyk.k}`
}

export function formatRgb(rgb: RgbValue): string {
  return `${clampByte(rgb.r)},${clampByte(rgb.g)},${clampByte(rgb.b)}`
}

export function formatHsb(hsb: HsbValue): string {
  return `${Math.round(hsb.h)},${Math.round(hsb.s)},${Math.round(hsb.b)}`
}

/** RGB → HSB（h 0-360，s/b 0-100） */
export function rgbToHsb(rgb: RgbValue): HsbValue {
  const r = clampByte(rgb.r) / 255
  const g = clampByte(rgb.g) / 255
  const b = clampByte(rgb.b) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s = max === 0 ? 0 : (d / max) * 100
  return { h: Math.round(h), s: Math.round(s), b: Math.round(max * 100) }
}

/** HSB（h 0-360，s/b 0-100）→ RGB */
export function hsbToRgb(hsb: HsbValue): RgbValue {
  const h = ((hsb.h % 360) + 360) % 360
  const s = Math.min(100, Math.max(0, hsb.s)) / 100
  const v = Math.min(100, Math.max(0, hsb.b)) / 100
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let rgb: [number, number, number]
  if (h < 60) rgb = [c, x, 0]
  else if (h < 120) rgb = [x, c, 0]
  else if (h < 180) rgb = [0, c, x]
  else if (h < 240) rgb = [0, x, c]
  else if (h < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return {
    r: clampByte((rgb[0] + m) * 255),
    g: clampByte((rgb[1] + m) * 255),
    b: clampByte((rgb[2] + m) * 255),
  }
}

/** 解析 "31,42,68" / "31 42 68" / "31，42，68" 格式的 RGB */
export function parseRgb(text: string): RgbValue | null {
  const parts = text.split(/[,，\s]+/).filter(Boolean)
  if (parts.length !== 3) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null
  return { r: nums[0]!, g: nums[1]!, b: nums[2]! }
}

/** 解析 "56,39,0,73" 格式的 CMYK（百分比 0-100） */
export function parseCmyk(text: string): CmykValue | null {
  const parts = text.split(/[,，\s]+/).filter(Boolean)
  if (parts.length !== 4) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 100)) return null
  return { c: nums[0]!, m: nums[1]!, y: nums[2]!, k: nums[3]! }
}

/** 解析 "231,55,27" 格式的 HSB（h 0-360，s/b 0-100） */
export function parseHsb(text: string): HsbValue | null {
  const parts = text.split(/[,，\s]+/).filter(Boolean)
  if (parts.length !== 3) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null
  const [h, s, b] = nums as [number, number, number]
  if (h > 360 || s > 100 || b > 100) return null
  return { h, s, b }
}

/** RGB 欧氏距离最近的色库名（自定义色的命名提示） */
export function nearestColorName(
  hex: string,
  library: Array<{ name: string; hex: string }>,
): string | null {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  let best: { name: string; dist: number } | null = null
  for (const swatch of library) {
    const srgb = hexToRgb(swatch.hex)
    if (!srgb) continue
    const dist =
      (rgb.r - srgb.r) ** 2 + (rgb.g - srgb.g) ** 2 + (rgb.b - srgb.b) ** 2
    if (!best || dist < best.dist) best = { name: swatch.name, dist }
  }
  return best?.name ?? null
}
