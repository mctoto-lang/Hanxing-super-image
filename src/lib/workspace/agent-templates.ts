/**
 * 工作台 Agent 模板注册表（三条产品线 · 纯数据 + 纯函数，零 DB / 网络依赖）
 *
 * 模板 = 一条成套卡牌产品线的完整制作规格：元数据 + 卡片骨架 + 提示词写作
 * 规则 + 默认阈值/尺寸。共享类型见 ./agent-types；本文件消费这些类型并
 * 提供注册表查找、评审加权聚合、阶段状态映射与神谕 CSV 导出等纯函数，
 * 可安全进入客户端 bundle（服务端 actions / 前端组件统一从此处导入）。
 *
 * 三条产品线的成品张数（牌面 + 四类套件交付物，逐张入骨架）：
 * - tarot81：塔罗 81 = 78 牌面（22 大阿卡纳 + 56 小阿卡纳）+ 牌背 + 边框
 *   + 牌盒（3/4 视图）；
 * - poker58：扑克 58 = 54 标准牌（4 花色 × 13 + 大小王）+ 替换牌面 + 牌背
 *   + 边框 + 牌盒；
 * - oracle58：神谕 58 = 55 牌面（5 组 × 11 位置）+ 牌背 + 边框 + 牌盒。
 */
import type {
  WorkspaceAgentCandidate,
  WorkspaceAgentCardSkeleton,
  WorkspaceAgentCardStatus,
  WorkspaceAgentEventStage,
  WorkspaceAgentFrozenConfig,
  WorkspaceAgentQuality,
  WorkspaceAgentSizeKind,
  WorkspaceAgentStage,
  WorkspaceAgentStageProgress,
  WorkspaceAgentStageStatus,
  WorkspaceAgentTemplate,
  WorkspaceAgentTemplateCardKind,
  WorkspaceAgentTemplateKey,
  WorkspaceAgentTemplateMeta,
  WorkspaceAgentTemplateSizes,
} from "./agent-types"

// ---------------------------------------------------------------------------
// 通用小工具与套件交付物规格（三模板共用）
// ---------------------------------------------------------------------------

/** 序号补零到两位（骨架 key 可读且等宽，如 major-00 / minor-wands-07） */
function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

/** 把任意分数收敛到 0-100 整数（四舍五入；与 agent 域 clampScore 同口径） */
function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** 套件交付物规格（整副一份，随牌面逐张入骨架；K 为该套件的 kind 字面量） */
interface KitSpec<K extends WorkspaceAgentTemplateCardKind = WorkspaceAgentTemplateCardKind> {
  kind: K
  key: string
  name: string
  hint: string
}

const KIT_BACK: KitSpec<"back"> = {
  kind: "back",
  key: "kit-back",
  name: "牌背",
  hint: "整副共用牌背：180° 旋转对称构图，无方向性光源、无文字，四边留裁切安全区",
}

const KIT_BORDER: KitSpec<"border"> = {
  kind: "border",
  key: "kit-border",
  name: "边框",
  hint: "卡牌边框：四边纹样带宽一致、连续对称，中心为干净预留区（交付阶段叠加到每张卡面）",
}

const KIT_BOX: KitSpec<"box"> = {
  kind: "box",
  key: "kit-box",
  name: "牌盒",
  hint: "牌盒主视觉：呈现整套牌的氛围，预留标题排版区，比例与卡面一致不变形",
}

/** 塔罗牌盒为 3/4 视图（同一 kind，提示词强调视角） */
const KIT_BOX_TAROT: KitSpec<"box"> = {
  kind: "box",
  key: "kit-box",
  name: "牌盒",
  hint: "牌盒 3/4 视图主视觉：呈现整套牌的氛围与盒体立体感，预留标题排版区，比例与卡面一致不变形",
}

/** 扑克替换牌面（印制备用：与标准牌面同规格的替换卡） */
const KIT_REPLACEMENT: KitSpec<"replacement"> = {
  kind: "replacement",
  key: "kit-replacement",
  name: "替换牌面",
  hint: "印制备用替换牌面：与标准牌面同规格同比例，任选一张卡面样式重制，不出现文字与字母",
}

/** 模板卡片类型 → 中文标签（CSV 导出与列表筛选共用） */
export const TEMPLATE_CARD_KIND_LABELS: Record<WorkspaceAgentTemplateCardKind, string> = {
  major: "大阿卡纳",
  number: "点数牌",
  court: "人物牌",
  joker: "大小王",
  position: "位置牌",
  back: "牌背",
  border: "边框",
  box: "牌盒",
  replacement: "替换牌面",
}

// ---------------------------------------------------------------------------
// 塔罗 81（78 牌面 + 牌背 + 边框 + 牌盒 3/4 视图）
// ---------------------------------------------------------------------------

export const TAROT81_CARD_COUNT = 81
/** 牌面张数（不含套件交付物） */
export const TAROT81_FACE_COUNT = 78
export const TAROT81_KIT_COUNT = 3
export const TAROT81_MAJOR_COUNT = 22
/** 小阿卡纳每花色张数（王牌-国王） */
const TAROT_CARDS_PER_SUIT = 14

/** 小阿卡纳花色 ASCII id（顺序与 tarotSkeleton() 出牌顺序一致：权杖/圣杯/宝剑/星币） */
const TAROT_SUIT_IDS = ["wands", "cups", "swords", "pentacles"] as const
export type Tarot81SuitId = (typeof TAROT_SUIT_IDS)[number]

export interface Tarot81CardSkeleton extends WorkspaceAgentCardSkeleton {
  kind: "major" | "number" | "court" | "back" | "border" | "box"
  /** 大阿卡纳 = major；小阿卡纳 = minor；套件交付物 = null */
  arcana: "major" | "minor" | null
  /** 小阿卡纳花色 id；大阿卡纳与套件交付物为 null */
  suit: Tarot81SuitId | null
  /** 小阿卡纳牌阶 1-14（王牌=1 … 国王=14）；大阿卡纳与套件交付物为 null */
  rank: number | null
}

const TAROT_KIT = [KIT_BACK, KIT_BORDER, KIT_BOX_TAROT] as const

// ---------------------------------------------------------------------------
// 塔罗 78 张牌名骨架（牌名与顺序的唯一事实来源）
// ---------------------------------------------------------------------------

const TAROT_SUITS = [
  { suit: "权杖", element: "火 · 行动与创造" },
  { suit: "圣杯", element: "水 · 情感与关系" },
  { suit: "宝剑", element: "风 · 思维与冲突" },
  { suit: "星币", element: "土 · 物质与现实" },
] as const

const TAROT_MAJOR_NAMES = [
  "愚者", "魔术师", "女祭司", "女皇", "皇帝", "教皇", "恋人", "战车",
  "力量", "隐士", "命运之轮", "正义", "倒吊人", "死神", "节制", "恶魔",
  "塔", "星星", "月亮", "太阳", "审判", "世界",
] as const

const TAROT_MINOR_RANKS = [
  "王牌", "二", "三", "四", "五", "六", "七", "八", "九", "十",
  "侍从", "骑士", "王后", "国王",
] as const

/** 塔罗 78 张骨架（大阿卡纳 22 在前，顺序固定；小阿卡纳四花色各 14） */
function tarotSkeleton(): { index: number; name: string; hint: string }[] {
  const cards: { index: number; name: string; hint: string }[] = []
  TAROT_MAJOR_NAMES.forEach((name, i) => {
    cards.push({ index: i, name: `${name}`, hint: "大阿卡纳" })
  })
  let idx = 22
  for (const { suit, element } of TAROT_SUITS) {
    for (const rank of TAROT_MINOR_RANKS) {
      cards.push({ index: idx, name: `${suit}${rank}`, hint: `小阿卡纳 · ${suit}（${element}）` })
      idx++
    }
  }
  return cards
}

/**
 * 塔罗 81 张骨架：0-21 大阿卡纳 → 22-77 小阿卡纳（权杖/圣杯/宝剑/星币各 14）
 * → 78-80 套件交付物（牌背/边框/牌盒 3/4 视图）。牌名与 hint 包装自
 * tarotSkeleton()，本文件不重复定义牌名（单一事实来源）。
 */
export const TAROT81_CARDS: Tarot81CardSkeleton[] = [
  ...tarotSkeleton().map((card): Tarot81CardSkeleton => {
    if (card.index < TAROT81_MAJOR_COUNT) {
      return {
        index: card.index,
        key: `major-${pad2(card.index)}`,
        name: card.name,
        hint: card.hint,
        kind: "major",
        arcana: "major",
        suit: null,
        rank: null,
      }
    }
    const minorOffset = card.index - TAROT81_MAJOR_COUNT
    const suit = TAROT_SUIT_IDS[Math.floor(minorOffset / TAROT_CARDS_PER_SUIT)]!
    const rank = (minorOffset % TAROT_CARDS_PER_SUIT) + 1
    return {
      index: card.index,
      key: `minor-${suit}-${pad2(rank)}`,
      name: card.name,
      hint: card.hint,
      kind: rank <= 10 ? "number" : "court",
      arcana: "minor",
      suit,
      rank,
    }
  }),
  ...TAROT_KIT.map((spec, i): Tarot81CardSkeleton => ({
    index: TAROT81_FACE_COUNT + i,
    key: spec.key,
    name: spec.name,
    hint: spec.hint,
    kind: spec.kind,
    arcana: null,
    suit: null,
    rank: null,
  })),
]

export const TAROT81_META: WorkspaceAgentTemplateMeta = {
  key: "tarot81",
  name: "塔罗牌 81 张全套",
  description:
    "标准 78 张塔罗（22 大阿卡纳 + 56 小阿卡纳）+ 牌背/边框/牌盒（3/4 视图）3 项套件交付物，四阶段流水线产出可直接印刷的整套设计稿。",
  cardCount: TAROT81_CARD_COUNT,
  kitCount: TAROT81_KIT_COUNT,
}

// ---------------------------------------------------------------------------
// 扑克 58（54 标准牌 + 替换牌面 + 牌背 + 边框 + 牌盒）
// ---------------------------------------------------------------------------

export const POKER58_CARD_COUNT = 58
/** 标准牌张数（4 花色 × 13 + 大小王；不含替换牌面与套件交付物） */
export const POKER58_FACE_COUNT = 54
export const POKER58_KIT_COUNT = 4

const POKER_SUITS = [
  { id: "spades", name: "黑桃", symbol: "♠" },
  { id: "hearts", name: "红心", symbol: "♥" },
  { id: "diamonds", name: "方块", symbol: "♦" },
  { id: "clubs", name: "梅花", symbol: "♣" },
] as const
export type Poker58SuitId = (typeof POKER_SUITS)[number]["id"]

/** 点数牌面值（A=1，2-10 按面值）；J/Q/K 与大小王为 null */
const RANK_PIP_VALUES: Record<string, number> = {
  A: 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
}

const POKER_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const
export type Poker58Rank = (typeof POKER_RANKS)[number]

export interface Poker58CardSkeleton extends WorkspaceAgentCardSkeleton {
  kind: "number" | "court" | "joker" | "replacement" | "back" | "border" | "box"
  /** 花色 id；大小王、替换牌面与套件交付物为 null */
  suit: Poker58SuitId | null
  /** 点数面值（A=1 … 10）；J/Q/K、大小王与套件交付物为 null */
  pipCount: number | null
  /** 牌面点数字母（A/2-10/J/Q/K）；大小王与套件交付物为 null */
  rank: Poker58Rank | null
  /** 大王/小王；其余为 null */
  joker: "big" | "small" | null
}

const POKER_KIT = [KIT_REPLACEMENT, KIT_BACK, KIT_BORDER, KIT_BOX] as const

/** 主题卡面统一骨架提示（纯主题卡口径：无花色/点数语义，主体由选定主题发散） */
const POKER_THEME_CARD_HINT =
  "主题卡片：围绕选定主题与方向，构思一个独立、明确的画面主体（人物/动物/物品或其组合）并作场景化演绎，与整套其他卡面明显区分"

/**
 * 扑克 58 张骨架（LLM 侧按主题卡片处理，不携带花色/点数语义）：
 * 0-51 主题卡 01-52（key 保留 poker-{花色}-{点数} 以稳定结构）→ 52-53 主角卡
 * /主角对卡 → 54 替换牌面 → 55-57 套件交付物（牌背/边框/牌盒）。
 */
export const POKER58_CARDS: Poker58CardSkeleton[] = [
  ...POKER_SUITS.flatMap((suit, suitIndex): Poker58CardSkeleton[] =>
    POKER_RANKS.map((rank, rankIndex): Poker58CardSkeleton => {
      const pipCount = RANK_PIP_VALUES[rank] ?? null
      const index = suitIndex * POKER_RANKS.length + rankIndex
      return {
        index,
        key: `poker-${suit.id}-${rank}`,
        name: `主题卡 ${pad2(index + 1)}`,
        hint: POKER_THEME_CARD_HINT,
        kind: pipCount != null ? "number" : "court",
        suit: suit.id,
        pipCount,
        rank,
        joker: null,
      }
    }),
  ),
  {
    index: 52,
    key: "joker-big",
    name: "主角卡",
    hint: "主角卡：全套唯一的主角化形象，画面醒目、无文字",
    kind: "joker",
    suit: null,
    pipCount: null,
    rank: null,
    joker: "big",
  },
  {
    index: 53,
    key: "joker-small",
    name: "主角对卡",
    hint: "主角对卡：与主角卡成对的收敛版本，去色处理",
    kind: "joker",
    suit: null,
    pipCount: null,
    rank: null,
    joker: "small",
  },
  ...POKER_KIT.map((spec, i): Poker58CardSkeleton => ({
    index: POKER58_FACE_COUNT + i,
    key: spec.key,
    name: spec.name,
    hint: spec.hint,
    kind: spec.kind,
    suit: null,
    pipCount: null,
    rank: null,
    joker: null,
  })),
]

export const POKER58_META: WorkspaceAgentTemplateMeta = {
  key: "poker58",
  name: "扑克牌 58 张全套",
  description:
    "标准 54 张扑克（4 花色 × 13 + 大小王）+ 替换牌面/牌背/边框/牌盒 4 项套件交付物，四阶段流水线产出可直接印刷的整套设计稿。",
  cardCount: POKER58_CARD_COUNT,
  kitCount: POKER58_KIT_COUNT,
}

// ---------------------------------------------------------------------------
// 神谕 58（55 牌面（5 组 × 11 位置）+ 牌背 + 边框 + 牌盒）
// ---------------------------------------------------------------------------

export const ORACLE58_CARD_COUNT = 58
/** 牌面张数（不含套件交付物） */
export const ORACLE58_FACE_COUNT = 55
export const ORACLE58_GROUP_COUNT = 5
export const ORACLE58_POSITIONS_PER_GROUP = 11
export const ORACLE58_KIT_COUNT = 3

/** 默认组名（组主题由用户输入/澄清结论决定；骨架用中性序数名占位） */
export const ORACLE_GROUP_ORDINALS = ["组一", "组二", "组三", "组四", "组五"] as const

/**
 * 11 个位置原型（每组内同一套原型轮转）：
 * 神谕卡无标准牌义体系，骨架以「旅程叙事」原型锁定每张卡的语义锚点——
 * 5 组共享同一位置序列，既保证跨组可比，又让整套卡构成五条平行叙事线。
 */
export const ORACLE_POSITION_ARCHETYPES = [
  { position: 1, name: "启程", hint: "开端与新芽：旅程起点，萌发与期待" },
  { position: 2, name: "召唤", hint: "内在感召：被更高目标唤醒的瞬间" },
  { position: 3, name: "试炼", hint: "第一道关卡：直面困难与不确定" },
  { position: 4, name: "盟友", hint: "同行与支援：旅途中出现的帮助者" },
  { position: 5, name: "迷障", hint: "幻象与内耗：看不清方向的时刻" },
  { position: 6, name: "转机", hint: "裂缝中的光：僵局松动的契机" },
  { position: 7, name: "深化", hint: "沉入内核：与真实自我相遇" },
  { position: 8, name: "牺牲", hint: "放手与交换：为所求付出代价" },
  { position: 9, name: "启示", hint: "顿悟时刻：真相显形，认知跃迁" },
  { position: 10, name: "圆满", hint: "丰盛与达成：阶段性完整" },
  { position: 11, name: "回归", hint: "带回礼物：重返日常并惠及他人" },
] as const
export type OraclePositionName = (typeof ORACLE_POSITION_ARCHETYPES)[number]["name"]

export interface OracleCardSkeleton extends WorkspaceAgentCardSkeleton {
  kind: "position" | "back" | "border" | "box"
  /** 所属组（1-5）；套件交付物为 null */
  groupIndex: number | null
  /** 组展示名（默认 组一…组五；可按用户主题重命名） */
  groupName: string | null
  /** 组内位置（1-11）；套件交付物为 null */
  position: number | null
  /** 位置原型名（启程/召唤/…/回归）；套件交付物为 null */
  positionName: string | null
}

const ORACLE_KIT = [KIT_BACK, KIT_BORDER, KIT_BOX] as const

/**
 * 构建神谕 58 张骨架（纯函数；组名可按用户主题重命名）：
 * - 位置牌：第 g 组（1-5）第 p 位（1-11），key = oracle-g{g}-p{pp}；
 * - 套件交付物：牌背/边框/牌盒。
 * groupNames 必须恰好 5 个（多/少直接抛错）；空白名回退默认序数名。
 */
export function buildOracleCards(groupNames?: readonly string[]): OracleCardSkeleton[] {
  if (groupNames && groupNames.length !== ORACLE58_GROUP_COUNT) {
    throw new Error(`神谕卡组名必须恰好 ${ORACLE58_GROUP_COUNT} 个，实际 ${groupNames.length} 个`)
  }
  const names = Array.from({ length: ORACLE58_GROUP_COUNT }, (_, i) => {
    const custom = groupNames?.[i]?.trim()
    return custom || ORACLE_GROUP_ORDINALS[i]!
  })
  const cards: OracleCardSkeleton[] = []
  for (let g = 1; g <= ORACLE58_GROUP_COUNT; g++) {
    const groupName = names[g - 1]!
    for (const archetype of ORACLE_POSITION_ARCHETYPES) {
      cards.push({
        index: cards.length,
        key: `oracle-g${g}-p${pad2(archetype.position)}`,
        name: `${groupName} · ${archetype.name}`,
        hint: `${archetype.hint}（组主题：${groupName}）`,
        kind: "position",
        groupIndex: g,
        groupName,
        position: archetype.position,
        positionName: archetype.name,
      })
    }
  }
  for (const spec of ORACLE_KIT) {
    cards.push({
      index: cards.length,
      key: spec.key,
      name: spec.name,
      hint: spec.hint,
      kind: spec.kind,
      groupIndex: null,
      groupName: null,
      position: null,
      positionName: null,
    })
  }
  return cards
}

/** 神谕 58 张默认骨架（默认组名；重命名场景用 buildOracleCards） */
export const ORACLE58_CARDS: OracleCardSkeleton[] = buildOracleCards()

export const ORACLE58_META: WorkspaceAgentTemplateMeta = {
  key: "oracle58",
  name: "神谕卡 58 张全套",
  description:
    "主题化神谕卡组：5 组 × 11 位置（旅程叙事原型轮转）+ 牌背/边框/牌盒 3 项套件交付物，组名随用户主题定制。",
  cardCount: ORACLE58_CARD_COUNT,
  kitCount: ORACLE58_KIT_COUNT,
}

// ---------------------------------------------------------------------------
// 注册表与查找
// ---------------------------------------------------------------------------

export const TAROT81_TEMPLATE: WorkspaceAgentTemplate = {
  meta: TAROT81_META,
  cards: TAROT81_CARDS,
}

export const POKER58_TEMPLATE: WorkspaceAgentTemplate = {
  meta: POKER58_META,
  cards: POKER58_CARDS,
}

export const ORACLE58_TEMPLATE: WorkspaceAgentTemplate = {
  meta: ORACLE58_META,
  cards: ORACLE58_CARDS,
}

/** 已注册模板（新增产品线在此追加并同步 WORKSPACE_AGENT_TEMPLATE_KEYS） */
export const WORKSPACE_AGENT_TEMPLATES: readonly WorkspaceAgentTemplate[] = [
  TAROT81_TEMPLATE,
  POKER58_TEMPLATE,
  ORACLE58_TEMPLATE,
]

/** 按 key 查模板；未注册返回 null */
export function getWorkspaceAgentTemplate(
  key: WorkspaceAgentTemplateKey,
): WorkspaceAgentTemplate | null {
  return WORKSPACE_AGENT_TEMPLATES.find((t) => t.meta.key === key) ?? null
}

/** 已注册模板的元数据列表（模板选择页用） */
export function listWorkspaceAgentTemplateMetas(): WorkspaceAgentTemplateMeta[] {
  return WORKSPACE_AGENT_TEMPLATES.map((t) => t.meta)
}

/** 模板成品张数（牌面 + 套件交付物）；未注册抛错（词表封闭，调用方已类型收敛） */
export function templateCardCount(key: WorkspaceAgentTemplateKey): number {
  const template = getWorkspaceAgentTemplate(key)
  if (!template) throw new Error(`未注册的工作台 Agent 模板：${key}`)
  return template.cards.length
}

// 骨架完整性守卫：张数/结构被误改时导入即炸（同 agent 域 tarot.ts 的守卫风格）
function assertSkeletonLength(name: string, cards: readonly WorkspaceAgentCardSkeleton[], expected: number): void {
  if (cards.length !== expected) {
    throw new Error(`${name} 骨架张数异常：期望 ${expected} 张，实际 ${cards.length} 张`)
  }
}
assertSkeletonLength("塔罗 81", TAROT81_CARDS, TAROT81_CARD_COUNT)
assertSkeletonLength("扑克 58", POKER58_CARDS, POKER58_CARD_COUNT)
assertSkeletonLength("神谕 58", ORACLE58_CARDS, ORACLE58_CARD_COUNT)

// ---------------------------------------------------------------------------
// 模板提示词写作规则（注入提示词设计师 system prompt；风格词由系统拼接）
// ---------------------------------------------------------------------------

/** 通用画面规则（三模板共享；口径对齐 agent 域 DEFAULT_ART_RULES） */
export const SHARED_PROMPT_WRITING_RULES: readonly string[] = [
  "【画面规则】整套卡面必须严格遵守：",
  "1. 风格分离：你只撰写画面内容；固定风格提示词（整套逐字统一）与无边框结尾句由系统自动拼接到每张提示词末尾——撰写时不得自行添加任何艺术风格描述（媒介/画风流派/质感/整体色调色系等），写了会与固定风格冲突，破坏整套一致性。",
  "2. 篇幅：画面内容 120-200 字（约 160 字）中文单段连贯文本，覆盖主体、动作/神态、道具、场景氛围与场景内的具体光影；不逐项罗列成清单，保持行文自然。",
  "3. 主题明确：每张卡面有唯一明确的主体（人物/动物/物品或其组合），主体即该卡牌义的核心象征；禁止无主体的空泛场景或纯风景。",
  "4. 中文表述：画面内容一律用中文书写，不使用分段标记或序号；不输出任何负向提示词或「不要出现××」类禁令（无边框句由系统拼接）。",
  "5. 构图惯例：主体占画面 60% 以上、近景或特写、竖版构图（与卡面出图比例一致）、主体居中略偏上；多件物品自然成组、每件有支撑或落点、不悬空漂浮；不规定精确摆放方式与位置关系，摆放构图交给生图模型自由发挥。",
  "6. 边缘干净（无边框硬规则）：画面四边不得出现任何类似边框的连续内容——沿画面边缘连续分布的装饰纹样、线条、色带、留白描边一律禁止（卡面边框由交付阶段统一叠加，画面内出现即废卡）。",
  "7. 套件交付物按各自定位撰写：牌背严格 180° 旋转对称、无方向性光源与文字；边框四边纹样连续对称、中心预留区完全干净；牌盒主视觉呈现整套氛围并预留标题排版区（塔罗为 3/4 视图，需呈现盒体立体感）。",
]

/** 各模板专属规则（塔罗花色数量 / 扑克主题卡片 / 神谕位置语义） */
const TEMPLATE_PROMPT_RULES: Record<WorkspaceAgentTemplateKey, readonly string[]> = {
  tarot81: [
    "【花色数量硬规则】权杖/圣杯/宝剑/星币的王牌至十：画面必须包含恰好对应数量（1-10）的花色物品，并把数量明确写进描述（量词按物品形态选择，如「五只圣杯」「三根权杖」）；花色物品只写数量与形态细节，不描述具体的摆放方式与位置关系；数量较多（六件及以上）时以一句自然的整体呈现交代、只点明总数，不逐件描述位置朝向。侍从/骑士/王后/国王与大阿卡纳不要求画面体现牌名或身份文字，只需主题明确、贴合牌义。",
  ],
  poker58: [
    "【主题卡片规则】整套按主题卡片撰写：每张卡面围绕选定主题构思一个独立、明确的画面主体，整套 54 张卡面主体互不重复，从主题的不同侧面（角色/生物/器物/场景切片等）取材。两张主角卡中，一张为全套唯一的主角化形象（画面醒目），另一张为其去色收敛对卡。替换牌面为印制备用规格：与标准牌面同规格同比例，任选一张卡面样式重制，不出现文字与字母。",
  ],
  oracle58: [
    "【位置语义规则】每张位置牌的画面必须呈现该位置原型的核心象征（见骨架提示），并融入所属组的主题意象；同组 11 张在色彩母题与元素选择上相互呼应，跨组共享整套风格。",
  ],
}

/** 取某模板的完整写作规则（共享规则 + 模板专属规则；未注册抛错） */
export function promptWritingRulesFor(key: WorkspaceAgentTemplateKey): readonly string[] {
  const specific = TEMPLATE_PROMPT_RULES[key]
  if (!specific) throw new Error(`未注册的工作台 Agent 模板：${key}`)
  return [...SHARED_PROMPT_WRITING_RULES, ...specific]
}

/**
 * LLM 视角的产品线文案（风格策划【产品线】行用）：
 * - tarot81 / oracle58 沿用 meta 原文；
 * - poker58 中性化为主题卡牌口径——方向/主题不得渗入扑克语义，
 *   模板选择页 UI 仍展示 meta 原文（产品入口口径不变）。
 */
export const TEMPLATE_LLM_PRODUCT_LINES: Record<
  WorkspaceAgentTemplateKey,
  { name: string; description: string }
> = {
  tarot81: { name: TAROT81_META.name, description: TAROT81_META.description },
  poker58: {
    name: "主题卡牌 58 张全套",
    description:
      "54 张主题卡面（纯主题卡片，无固定牌面语义）+ 替换卡面/牌背/边框/牌盒 4 项套件交付物，四阶段流水线产出可直接印刷的整套设计稿。",
  },
  oracle58: { name: ORACLE58_META.name, description: ORACLE58_META.description },
}

// ---------------------------------------------------------------------------
// 默认阈值 / 打回上限与冻结配置构建
// ---------------------------------------------------------------------------

/** 默认及格线（0-100；三维度统一 75，用户可 10 分一档覆盖） */
export const DEFAULT_REVIEW_THRESHOLD = 75
/** 默认打回上限（逐卡计数；0-3） */
export const DEFAULT_MAX_RETRIES = 2

/** 及格线取值范围（与服务端 schema 校验一致：下限 40、上限 95） */
export const THRESHOLD_MIN = 40
export const THRESHOLD_MAX = 95
/** 打回上限取值范围 */
export const MAX_RETRIES_MIN = 0
export const MAX_RETRIES_MAX = 3

/** 默认质量要求（阈值 75 / 打回 2） */
export function defaultQuality(): WorkspaceAgentQuality {
  return {
    contentThreshold: DEFAULT_REVIEW_THRESHOLD,
    aestheticThreshold: DEFAULT_REVIEW_THRESHOLD,
    consistencyThreshold: DEFAULT_REVIEW_THRESHOLD,
    maxRetries: DEFAULT_MAX_RETRIES,
  }
}

/** 钳制到 [40, 95] 并取整 */
export function clampThreshold(value: number): number {
  return Math.max(THRESHOLD_MIN, Math.min(THRESHOLD_MAX, Math.round(value)))
}

/** 钳制到 [0, 3] 并取整 */
export function clampMaxRetries(value: number): number {
  return Math.max(MAX_RETRIES_MIN, Math.min(MAX_RETRIES_MAX, Math.round(value)))
}

/** 钳制到 [40, 95] 并就近取 5 分一档（评审唯一通过口径与单项及格线同档） */
function clampThresholdToStep(value: number): number {
  return clampThreshold(Math.round(value / 5) * 5)
}

/**
 * 构建冻结配置（发起时调用一次，结果随 input 落 jsonb）：
 * - cardCount 取模板骨架长度（模板演进不影响进行中的 workflow）；
 * - quality/sizes 的缺省项回退模板默认值，越界值就地钳制；
 * - frozenAt 由调用方传入（保持纯函数，不读时钟）。
 */
export function buildFrozenConfig(input: {
  templateKey: WorkspaceAgentTemplateKey
  quality?: Partial<WorkspaceAgentQuality>
  sizes?: Partial<WorkspaceAgentTemplateSizes>
  frozenAt: string
}): WorkspaceAgentFrozenConfig {
  const defaults = defaultQuality()
  const qualityThreshold = input.quality?.qualityThreshold
  const quality: WorkspaceAgentQuality = {
    contentThreshold: clampThreshold(input.quality?.contentThreshold ?? defaults.contentThreshold),
    aestheticThreshold: clampThreshold(input.quality?.aestheticThreshold ?? defaults.aestheticThreshold),
    consistencyThreshold: clampThreshold(input.quality?.consistencyThreshold ?? defaults.consistencyThreshold),
    maxRetries: clampMaxRetries(input.quality?.maxRetries ?? defaults.maxRetries),
    // 评审唯一通过口径（加权总分线）：透传并钳制到 40-95、5 分一档；未提供
    // 或非法（非有限数字）时保持缺省，读取侧回退链（input.ts
    // readQualityThresholds）落 DEFAULT_REVIEW_THRESHOLD（jsonb 免迁移）
    ...(typeof qualityThreshold === "number" && Number.isFinite(qualityThreshold)
      ? { qualityThreshold: clampThresholdToStep(qualityThreshold) }
      : {}),
  }
  return {
    templateKey: input.templateKey,
    cardCount: templateCardCount(input.templateKey),
    quality,
    sizes: { ...DEFAULT_TEMPLATE_SIZES[input.templateKey], ...input.sizes },
    frozenAt: input.frozenAt,
  }
}

// ---------------------------------------------------------------------------
// 四类尺寸映射（卡面 / 牌背 / 边框 / 牌盒；与骨架尾部套件交付物一一对应）
// ---------------------------------------------------------------------------

/**
 * 各模板默认尺寸（"宽x高"；替换牌面按卡面规格出图，不单列）：
 * - tarot81 / oracle58：卡面系 2:3（1024x1536），牌盒 3:2（1536x1024）；
 * - poker58：卡面系 3:4（768x1024，5:7 印制比例的安全近似），牌盒 4:3（1024x768）。
 * 管理员/用户可按生图模型的启用预设覆盖（buildFrozenConfig 的 sizes 入参）。
 */
export const DEFAULT_TEMPLATE_SIZES: Record<WorkspaceAgentTemplateKey, WorkspaceAgentTemplateSizes> = {
  tarot81: { card: "1024x1536", back: "1024x1536", border: "1024x1536", box: "1536x1024" },
  poker58: { card: "768x1024", back: "768x1024", border: "768x1024", box: "1024x768" },
  oracle58: { card: "1024x1536", back: "1024x1536", border: "1024x1536", box: "1536x1024" },
}

/** 保留当前仍受新模型支持的尺寸，其余类别回退模板默认值或模型首个预设。 */
export function resolveCompatibleTemplateSizes(input: {
  templateKey: WorkspaceAgentTemplateKey
  current: WorkspaceAgentTemplateSizes
  enabledSizes: readonly string[]
}): WorkspaceAgentTemplateSizes | null {
  const available = [...new Set(input.enabledSizes)]
  if (available.length === 0) return null
  const defaults = DEFAULT_TEMPLATE_SIZES[input.templateKey]
  const pick = (kind: keyof WorkspaceAgentTemplateSizes) => {
    if (available.includes(input.current[kind])) return input.current[kind]
    if (available.includes(defaults[kind])) return defaults[kind]
    return available[0]!
  }
  return {
    card: pick("card"),
    back: pick("back"),
    border: pick("border"),
    box: pick("box"),
  }
}

/** 组合用户风格描述与参考图分析，避免确认后把同一段风格重复送入模型。 */
export function workspaceAgentReferenceStyleLines(input: {
  stylePrompt?: string | null
  referenceStyleAnalysis?: string | null
}): string[] {
  const stylePrompt = input.stylePrompt?.trim() ?? ""
  const analysis = input.referenceStyleAnalysis?.trim() ?? ""
  const lines: string[] = []
  if (analysis && analysis !== stylePrompt) {
    lines.push(`【参考图 AI 风格分析】${analysis}`)
  }
  if (stylePrompt) lines.push(`【用户风格描述】${stylePrompt}`)
  return lines
}

/** 取某模板某类资产的默认尺寸；未知 key 运行时回退 tarot81 的卡面尺寸（类型层已封闭） */
export function templateSizeOf(
  templateKey: WorkspaceAgentTemplateKey,
  kind: WorkspaceAgentSizeKind,
): string {
  const sizes = DEFAULT_TEMPLATE_SIZES[templateKey] ?? DEFAULT_TEMPLATE_SIZES.tarot81
  return sizes[kind] ?? sizes.card
}

/**
 * 交付卡类（DB 卡片行 kind）→ 冻结尺寸类别（frozen.sizes 的 key）：
 * face 共用 card 尺寸；back / border / box 套件各自独立。
 */
export function cardKindToSizeKind(
  kind: "face" | "back" | "box" | "border",
): WorkspaceAgentSizeKind {
  switch (kind) {
    case "back":
      return "back"
    case "border":
      return "border"
    case "box":
      return "box"
    default:
      return "card"
  }
}

// ---------------------------------------------------------------------------
// 评审加权聚合（多评审员：分数加权平均，内容/违规项按权重多数票）
// ---------------------------------------------------------------------------

/** 单个评审员的一票（weight 缺省 1 = 等权多数票，对齐 agent 域口径） */
export interface WorkspaceAgentReviewerVote {
  reviewerId: string
  reviewerName?: string
  /** 权重（> 0；用于「主力评审员」与「辅助评审员」差异化） */
  weight?: number
  contentPass: boolean
  contentScore: number
  aestheticScore: number
  consistencyScore: number
  violations: string[]
  /** 该评审员的评审理由（聚合后合并留档） */
  reason?: string
}

/** 加权聚合结论（供总控规则节点与前端评分卡共用） */
export interface WorkspaceAgentWeightedReview {
  contentPass: boolean
  contentScore: number
  aestheticScore: number
  consistencyScore: number
  violations: string[]
  /** 各评审员的非空理由（去空保序） */
  reasons: string[]
  reviewerCount: number
  /** 权重合计（> 0） */
  totalWeight: number
  /** 判内容通过的权重合计 */
  passedWeight: number
}

/**
 * 聚合 1~3 个评审员的加权投票：
 * - 三维分数：加权平均后收敛 0-100（四舍五入）；
 * - 内容通过 / 违规项：按权重多数票（> 总权重的一半才成立）；
 * - 单评审员保持一票否决（对齐 review.majorityVotePassed，避免低质量图被平均分掩盖）；
 * - 空投票或非正权重直接抛错（调用方 bug 早暴露）。
 */
export function aggregateWeightedReview(
  votes: readonly WorkspaceAgentReviewerVote[],
): WorkspaceAgentWeightedReview {
  if (votes.length === 0) {
    throw new Error("至少需要一个评审员")
  }
  const weighted = votes.map((vote) => {
    const weight = vote.weight ?? 1
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`评审员权重必须为正数：${vote.reviewerId}`)
    }
    return { vote, weight }
  })
  const totalWeight = weighted.reduce((sum, { weight }) => sum + weight, 0)
  const passedWeight = weighted
    .filter(({ vote }) => vote.contentPass)
    .reduce((sum, { weight }) => sum + weight, 0)
  const single = weighted.length === 1
  const contentPass = single ? passedWeight === totalWeight : passedWeight > totalWeight / 2

  const weightedScore = (pick: (vote: WorkspaceAgentReviewerVote) => number): number =>
    clampScore(weighted.reduce((sum, { vote, weight }) => sum + pick(vote) * weight, 0) / totalWeight)

  const violationWeights = new Map<string, number>()
  for (const { vote, weight } of weighted) {
    for (const violation of vote.violations) {
      violationWeights.set(violation, (violationWeights.get(violation) ?? 0) + weight)
    }
  }
  const violations = [...violationWeights.entries()]
    .filter(([, weight]) => (single ? weight > 0 : weight > totalWeight / 2))
    .map(([violation]) => violation)

  return {
    contentPass,
    contentScore: weightedScore((vote) => vote.contentScore),
    aestheticScore: weightedScore((vote) => vote.aestheticScore),
    consistencyScore: weightedScore((vote) => vote.consistencyScore),
    violations,
    reasons: weighted.map(({ vote }) => vote.reason).filter((reason): reason is string => Boolean(reason)),
    reviewerCount: weighted.length,
    totalWeight,
    passedWeight,
  }
}

/** 阈值入参（WorkspaceAgentQuality 的三维阈值子集，前端评分卡可直接传入） */
export type WorkspaceAgentThresholdInput = Pick<
  WorkspaceAgentQuality,
  "contentThreshold" | "aestheticThreshold" | "consistencyThreshold"
>

/**
 * 加权聚合结论 → 是否放行（总控裁决的阈值判定，前端评分卡共用同一口径）：
 * 内容通过 + 无违规项 + 三维分数均达及格线。
 */
export function weightedReviewPasses(
  aggregate: WorkspaceAgentWeightedReview,
  thresholds: WorkspaceAgentThresholdInput,
): boolean {
  return (
    aggregate.contentPass &&
    aggregate.violations.length === 0 &&
    aggregate.contentScore >= thresholds.contentThreshold &&
    aggregate.aestheticScore >= thresholds.aestheticThreshold &&
    aggregate.consistencyScore >= thresholds.consistencyThreshold
  )
}

// ---------------------------------------------------------------------------
// 生图评审循环（review_image）：加权总分 + 裁决 + 跨尝试选优（纯函数）
// ---------------------------------------------------------------------------

/** 加权总分的维度权重（产品确认：审美 0.4 / 一致性 0.3 / 内容 0.3） */
export const REVIEW_TOTAL_WEIGHTS = {
  aesthetic: 0.4,
  consistency: 0.3,
  content: 0.3,
} as const

/** 三维数值分（0-100 整数；聚合后无 null） */
export interface ReviewTotalScores {
  content: number
  aesthetic: number
  consistency: number
}

/**
 * 加权总分 = round(0.4×审美 + 0.3×一致性 + 0.3×内容)。
 * 非有限分值直接抛错（调用方 bug 早暴露；分数已在上游 clamp 到 0-100）。
 */
export function computeWeightedTotalScore(scores: ReviewTotalScores): number {
  const total =
    REVIEW_TOTAL_WEIGHTS.aesthetic * scores.aesthetic +
    REVIEW_TOTAL_WEIGHTS.consistency * scores.consistency +
    REVIEW_TOTAL_WEIGHTS.content * scores.content
  if (!Number.isFinite(total)) {
    throw new Error("加权总分计算失败：维度分值非法")
  }
  return Math.round(total)
}

/**
 * 通过判定（唯一口径）：加权总分 ≥ 质量及格线即通过。
 * 任何单项维度（内容/审美/一致性）都不得一票否决——单项分仅作为改写依据留档。
 */
export function weightedTotalPasses(
  weightedTotalScore: number,
  qualityThreshold: number,
): boolean {
  return weightedTotalScore >= qualityThreshold
}

/** 评审循环裁决：approve 放行 / retry 打回（未耗尽）/ fallback 耗尽兜底 */
export function resolveReviewVerdict(input: {
  weightedTotalScore: number
  qualityThreshold: number
  roundsUsed: number
  maxRetries: number
}): "approve" | "retry" | "fallback" {
  if (weightedTotalPasses(input.weightedTotalScore, input.qualityThreshold)) {
    return "approve"
  }
  return input.roundsUsed < input.maxRetries ? "retry" : "fallback"
}

/** 多评审员三维分等权平均后收敛 0-100（空数组抛错） */
export function averageDimensionScores(
  votes: readonly ReviewTotalScores[],
): ReviewTotalScores {
  if (votes.length === 0) throw new Error("至少需要一个评审员")
  const avg = (pick: (v: ReviewTotalScores) => number): number =>
    clampScore(votes.reduce((sum, v) => sum + pick(v), 0) / votes.length)
  return {
    content: avg((v) => v.content),
    aesthetic: avg((v) => v.aesthetic),
    consistency: avg((v) => v.consistency),
  }
}

/** 选优入参的最小形状（workspace_agent_round 行的子集） */
export interface ScoredRoundLike {
  id: string
  imageUrl: string | null
  candidates: WorkspaceAgentCandidate[]
}

/**
 * 跨全部尝试（轮）选加权分最高的有图轮（耗尽兜底 / 展示复用）：
 * - 无图轮不参与（生图失败）；
 * - score 缺省（null，未评分）按 -1 计；
 * - 平分取后生成的轮（rounds 传入按 roundNumber 升序，取末个胜者）。
 */
export function pickBestScoredRound<T extends ScoredRoundLike>(
  rounds: readonly T[],
): T | null {
  let best: T | null = null
  let bestScore = -1
  for (const round of rounds) {
    if (!round.imageUrl) continue
    const score = round.candidates[0]?.score
    if (score == null) continue
    if (score >= bestScore) {
      bestScore = score
      best = round
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// 阶段状态映射（单卡状态 → 阶段；阶段进度 → 阶段展示状态）
// ---------------------------------------------------------------------------

/**
 * 任务类型（+方向轮次）→ 事件所属流水线模块：
 * supervisor 随 job 执行/重试/超时的事件按此归档到对应模块面板；
 * gen_directions 用 payload.round 区分主题轮（theme）与方向轮（direction）；
 * 无法可靠归档的类型返回 null（前端回退 nodeKey 白名单，不丢日志）。
 */
export function stageOfJobType(
  jobType: string,
  round?: string | null,
): WorkspaceAgentEventStage | null {
  switch (jobType) {
    case "analyze_reference_style":
      return "style_confirm"
    case "gen_directions":
      // 缺省按主题轮（与 run.ts 的 round 缺省口径一致）
      return round === "directions" ? "direction" : "theme"
    case "write_prompts":
    case "write_oracle_copy":
    case "translate_copy":
    case "revise_prompt":
    case "revise_card":
      return "prompt_writing"
    case "review_image":
    case "produce_cards":
    case "regen_image":
      return "art"
    default:
      return null
  }
}

/**
 * 阶段 → 该阶段归集的单卡状态（对 WORKSPACE_AGENT_CARD_STATUSES 的完整划分）：
 * - clarify 为 workflow 级（方向候选/选定），不落单卡状态；
 * - failed 归 art（生产失败）；cancelled 随工作流取消，统计时单独剔除，
 *   归入 compose 仅为让划分完整（如需精确归段以事件流为准）。
 */
export const STAGE_CARD_STATUSES: Record<WorkspaceAgentStage, readonly WorkspaceAgentCardStatus[]> = {
  clarify: [],
  draft: ["pending", "drafting"],
  art: ["generating", "reviewing", "approved_by_ai", "fallback", "failed"],
  compose: ["waiting_human", "confirmed", "cancelled"],
}

/** 单卡状态 → 所属阶段（词表封闭，switch 全覆盖） */
export function stageOfCardStatus(status: WorkspaceAgentCardStatus): WorkspaceAgentStage {
  switch (status) {
    case "pending":
    case "drafting":
      return "draft"
    case "generating":
    case "reviewing":
    case "approved_by_ai":
    case "fallback":
    case "failed":
      return "art"
    case "waiting_human":
    case "confirmed":
    case "cancelled":
      return "compose"
  }
}

const WORKSPACE_STAGE_INDEX: Record<WorkspaceAgentStage, number> = {
  clarify: 1,
  draft: 2,
  art: 3,
  compose: 4,
}

/** 阶段序号（clarify=1 … compose=4） */
export function stageOrder(stage: WorkspaceAgentStage): number {
  return WORKSPACE_STAGE_INDEX[stage] ?? 1
}

/** 阶段进度入参（WorkspaceAgentStageProgress 的计数子集） */
export type StageStatusProgress = Pick<WorkspaceAgentStageProgress, "total" | "completed" | "failed" | "inFlight">

/**
 * 单阶段展示状态：
 * - 已过阶段（序号小于当前）→ done；
 * - 未到阶段 → locked；
 * - 当前阶段：total > 0 且无在途且完成+失败 ≥ total → done，否则 active
 *   （clarify 等无逐卡单元的阶段恒 active，推进即翻 done）。
 */
export function resolveStageStatus(
  stage: WorkspaceAgentStage,
  currentStage: WorkspaceAgentStage,
  progress: StageStatusProgress = { total: 0, completed: 0, failed: 0, inFlight: 0 },
): WorkspaceAgentStageStatus {
  const order = stageOrder(stage)
  const current = stageOrder(currentStage)
  if (order < current) return "done"
  if (order > current) return "locked"
  if (progress.total > 0 && progress.inFlight === 0 && progress.completed + progress.failed >= progress.total) {
    return "done"
  }
  return "active"
}

/** 一次算齐四个阶段的展示状态（阶段条整行渲染用；缺省进度按 0 计） */
export function resolveStageStatuses(
  currentStage: WorkspaceAgentStage,
  progressByStage?: Partial<Record<WorkspaceAgentStage, StageStatusProgress>>,
): Record<WorkspaceAgentStage, WorkspaceAgentStageStatus> {
  const empty: StageStatusProgress = { total: 0, completed: 0, failed: 0, inFlight: 0 }
  const result = {} as Record<WorkspaceAgentStage, WorkspaceAgentStageStatus>
  for (const stage of ["clarify", "draft", "art", "compose"] as const) {
    result[stage] = resolveStageStatus(stage, currentStage, progressByStage?.[stage] ?? empty)
  }
  return result
}

// ---------------------------------------------------------------------------
// 神谕 CSV（骨架清单导出：5 组 × 11 位置 + 套件交付物；RFC 4180 转义）
// ---------------------------------------------------------------------------

/** CSV 列头（导出文件首行） */
export const ORACLE_CSV_COLUMNS = [
  "序号",
  "卡片Key",
  "组",
  "位置",
  "卡名",
  "类型",
  "骨架提示",
] as const

/**
 * 单元格转义（RFC 4180 最小口径）：含逗号/引号/换行的值整体加引号，
 * 内部引号翻倍；其余原样输出（不主动加引号，保持文件可读）。
 */
export function escapeCsvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * 神谕骨架 → CSV 文本（首行列头，行间 \n，结尾不带换行）。
 * 默认导出 ORACLE58_CARDS；重命名组名场景传 buildOracleCards(names) 的结果。
 */
export function oracleCardsToCsv(cards: readonly OracleCardSkeleton[] = ORACLE58_CARDS): string {
  const header = ORACLE_CSV_COLUMNS.map((column) => escapeCsvCell(column)).join(",")
  const rows = cards.map((card) =>
    [
      String(card.index),
      card.key,
      card.groupName ?? "-",
      card.position != null ? String(card.position) : "-",
      card.name,
      TEMPLATE_CARD_KIND_LABELS[card.kind],
      card.hint,
    ]
      .map((cell) => escapeCsvCell(cell))
      .join(","),
  )
  return [header, ...rows].join("\n")
}

// ---------------------------------------------------------------------------
// 神谕文案 CSV（55 组英文标题/正文交付物；RFC 4180 转义复用 escapeCsvCell）
// ---------------------------------------------------------------------------

/** 神谕文案 CSV 列头（交付物口径：序号、分组、英文标题、英文正文） */
export const ORACLE_COPY_CSV_COLUMNS = [
  "序号",
  "分组",
  "英文标题",
  "英文正文",
] as const

/** 神谕文案 CSV 单行（title = 一个凝练英文词；body = 一句英文正文） */
export interface OracleCopyCsvEntry {
  /** 全套序号（0 起，与骨架 index 一致） */
  index: number
  /** 组名（如「组一」，导出时原样） */
  groupName: string
  /** 英文标题（如 POISON） */
  headline: string
  /** 英文正文（一句，如 The toxicity you ignore is the dose you're choosing to swallow daily.） */
  message: string
}

/** 神谕文案 → CSV 文本（首行列头，行间 \n，结尾不带换行；空标题/正文按空串导出） */
export function oracleCopyRowsToCsv(entries: readonly OracleCopyCsvEntry[]): string {
  const header = ORACLE_COPY_CSV_COLUMNS.map((column) => escapeCsvCell(column)).join(",")
  const rows = entries.map((entry) =>
    [
      String(entry.index),
      entry.groupName,
      entry.headline,
      entry.message,
    ]
      .map((cell) => escapeCsvCell(cell ?? ""))
      .join(","),
  )
  return [header, ...rows].join("\n")
}
