/**
 * 穿戴图片字典（模特属性 / Tab 文案 / 常用服装色库）
 *
 * 代码内置常量：变更频率低且需要随代码审查；方向卡片与预置场景才是
 * 超管运营数据（DB 配置）。
 */

/** 子功能模式（四个 tab + templateInfo.mode） */
export const WEARTRY_MODES = ["outfit", "model", "accessory", "color"] as const
export type WeartryMode = (typeof WEARTRY_MODES)[number]

export const WEARTRY_MODE_LABELS: Record<WeartryMode, string> = {
  outfit: "服装组图",
  model: "模特穿戴",
  accessory: "AI万戴",
  color: "AI换色",
}

/**
 * 模特形象属性（性别/年龄/人种/体型）
 *
 * label 为界面展示中文；promptWord 为注入生图提示词的英文描述
 * （{{gender}}/{{age}}/{{race}}/{{bodyType}} 变量取 promptWord）。
 */
export interface ModelAttrDef {
  value: string
  label: string
  promptWord: string
}

export const MODEL_GENDERS: ModelAttrDef[] = [
  { value: "female", label: "女", promptWord: "female" },
  { value: "male", label: "男", promptWord: "male" },
  { value: "neutral", label: "中性", promptWord: "androgynous" },
]

export const MODEL_AGES: ModelAttrDef[] = [
  { value: "young", label: "青年", promptWord: "young adult (18-28)" },
  { value: "middle", label: "中年", promptWord: "middle-aged (30-45)" },
  { value: "teen", label: "少年", promptWord: "teenager (13-17)" },
  { value: "senior", label: "中老年", promptWord: "senior (50+)" },
]

export const MODEL_RACES: ModelAttrDef[] = [
  { value: "asian", label: "亚洲人", promptWord: "East Asian" },
  { value: "european", label: "欧美人", promptWord: "European/Caucasian" },
  { value: "african", label: "非洲人", promptWord: "African/Black" },
  { value: "latin", label: "拉丁人", promptWord: "Latin/Latino" },
]

export const MODEL_BODY_TYPES: ModelAttrDef[] = [
  { value: "slim", label: "纤瘦", promptWord: "slim" },
  { value: "standard", label: "标准", promptWord: "average build" },
  { value: "athletic", label: "健美", promptWord: "athletic/toned" },
  { value: "curvy", label: "丰满", promptWord: "curvy" },
  { value: "plus", label: "大码", promptWord: "plus-size" },
]

function findAttr(defs: ModelAttrDef[], value: string): ModelAttrDef | null {
  return defs.find((d) => d.value === value) ?? null
}

export const modelAttrHelpers = {
  gender: (v: string) => findAttr(MODEL_GENDERS, v),
  age: (v: string) => findAttr(MODEL_AGES, v),
  race: (v: string) => findAttr(MODEL_RACES, v),
  bodyType: (v: string) => findAttr(MODEL_BODY_TYPES, v),
}

/**
 * 常用服装色库（AI换色预设色卡）
 *
 * 服装行业常用色系（对齐 Pantone TCX 常用流行色的近似值），
 * 中文名 + HEX；注入提示词时附 HEX 便于模型对色。
 */
export interface ColorSwatch {
  name: string
  hex: string
}

export interface ColorSwatchGroup {
  group: string
  colors: ColorSwatch[]
}

export const COLOR_LIBRARY: ColorSwatchGroup[] = [
  {
    group: "基础色",
    colors: [
      { name: "纯白", hex: "#FFFFFF" },
      { name: "象牙白", hex: "#FFFFF0" },
      { name: "浅灰", hex: "#D3D3D3" },
      { name: "深灰", hex: "#4A4A4A" },
      { name: "纯黑", hex: "#000000" },
      { name: "米色", hex: "#F5F5DC" },
    ],
  },
  {
    group: "大地色",
    colors: [
      { name: "驼色", hex: "#C19A6B" },
      { name: "卡其", hex: "#C3B091" },
      { name: "棕色", hex: "#8B4513" },
      { name: "咖啡色", hex: "#6F4E37" },
      { name: "焦糖色", hex: "#C68E17" },
      { name: "燕麦色", hex: "#D9CBB3" },
    ],
  },
  {
    group: "蓝色系",
    colors: [
      { name: "藏青", hex: "#1F2A44" },
      { name: "牛仔蓝", hex: "#5B7C99" },
      { name: "雾霾蓝", hex: "#7A9BB5" },
      { name: "天蓝", hex: "#87CEEB" },
    ],
  },
  {
    group: "红粉系",
    colors: [
      { name: "正红", hex: "#E60012" },
      { name: "酒红", hex: "#8B1E3F" },
      { name: "玫红", hex: "#E0218A" },
      { name: "粉色", hex: "#F7CAD0" },
      { name: "豆沙粉", hex: "#C48A8A" },
    ],
  },
  {
    group: "绿黄紫",
    colors: [
      { name: "墨绿", hex: "#1F4A3C" },
      { name: "牛油果绿", hex: "#7BA05B" },
      { name: "军绿", hex: "#5B6340" },
      { name: "明黄", hex: "#FFD700" },
      { name: "芥末黄", hex: "#D1A32E" },
      { name: "紫色", hex: "#7B5EA7" },
      { name: "香芋紫", hex: "#C8A2C8" },
    ],
  },
]

export const COLOR_LIBRARY_FLAT: ColorSwatch[] = COLOR_LIBRARY.flatMap(
  (g) => g.colors,
)

/** 最近使用颜色（浏览器本地缓存）条目 */
export interface RecentColorEntry {
  name: string
  hex: string
  /** HSB 字符串（"231,55,27"），由 hex 换算产物 */
  hsb: string
  savedAt: number
}

export const RECENT_COLORS_STORAGE_KEY = "weartry:recent-colors"
export const RECENT_COLORS_MAX = 5

/** 各 tab 右侧介绍区文案（无批次时展示） */
export const WEARTRY_INTROS: Record<
  WeartryMode,
  { title: string; description: string; points: string[] }
> = {
  outfit: {
    title: "服装组图",
    description: "上传服装原图，勾选组图方向与张数，一次生成整套服装展示图。",
    points: [
      "支持模特全身/细节特写/场景搭配等方向（平台可配置）",
      "可选生图模型与图片比例",
      "补充要求支持 AI 帮写",
    ],
  },
  model: {
    title: "模特穿戴",
    description: "上传服装原图，选定预置场景与模特形象，生成真实上身效果图。",
    points: [
      "预置场景由平台配置并注入生图提示词",
      "模特形象可 AI 生成或自行上传",
      "支持性别/年龄/人种/体型组合",
    ],
  },
  accessory: {
    title: "AI万戴",
    description: "上传配饰原图，选定人物形象，生成全身搭配与细节视角穿戴图。",
    points: [
      "适配眼镜/首饰/帽子/包袋等配饰",
      "人物形象可 AI 生成或自行上传",
      "支持性别/年龄/人种/体型组合",
    ],
  },
  color: {
    title: "AI换色",
    description: "上传服装图片，指定目标部位与新颜色，保留质感一键换色。",
    points: [
      "常用服装色库 + HEX/HSB/RGB 自定义取色",
      "可指定换色部位（如上衣主体、裙摆）",
      "自动记录最近使用的 5 个颜色",
    ],
  },
}
