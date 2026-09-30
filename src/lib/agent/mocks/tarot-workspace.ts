/**
 * 塔罗工作台纯 Mock 数据（/agent/preview 专用）。
 *
 * 与 getTemplateWorkspaceAction 的返回严格同型（类型直接取自 server action，
 * 漂移即编译报错）；图片全部是内联 SVG data-URI 占位（渐变底 + 花色符号 +
 * 牌名角标，无网络请求），文案为占位中文，覆盖五阶段 × 三状态（等待 /
 * 进行中 / 失败）。本模块只出纯数据，可在单测中直接调用。
 */
import type {
  getTemplateWorkspaceAction,
  getTarotDeckScoresAction,
  getTarotDeliverablesAction,
} from "@/server/actions/agent-template"
import type { getRunItemDetailAction } from "@/server/actions/agent"
import type {
  AgentAssetKind,
  AgentClarifyQuestion,
  AgentPendingAction,
  AgentTemplateDirection,
  AgentTemplateStage,
} from "@/lib/agent/graph"

export type WorkspaceData = Awaited<ReturnType<typeof getTemplateWorkspaceAction>>
type WorkspaceItem = WorkspaceData["items"][number]
type WorkspaceRun = WorkspaceData["run"]

/** 预览可切换的阶段与状态 */
export type PreviewStage = AgentTemplateStage
export type PreviewStatus = "waiting_human" | "running" | "error"

const RUN_ID = "00000000-0000-4000-8000-00000000e001"
const ENTERPRISE_ID = "00000000-0000-4000-8000-000000000001"
const USER_ID = "00000000-0000-4000-8000-000000000002"

/** 小样卡序号（与 pipelines.sampleIndexes("tarot", 78, 6) 一致） */
const SAMPLE_INDEXES = [0, 1, 2, 5, 10, 21]

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000)
}

// ---------------------------------------------------------------------------
// 78 张牌名 + SVG 占位图
// ---------------------------------------------------------------------------

const MAJOR_ARCANA = [
  "愚者", "魔术师", "女祭司", "女皇", "皇帝", "教皇", "恋人", "战车",
  "力量", "隐士", "命运之轮", "正义", "倒吊人", "死神", "节制", "恶魔",
  "塔", "星星", "月亮", "太阳", "审判", "世界",
]

const SUITS = [
  { name: "权杖", symbol: "🪄", from: "#431407", via: "#9a3412", to: "#ea580c" },
  { name: "圣杯", symbol: "🏆", from: "#0c1e3d", via: "#1e3a8a", to: "#3b82f6" },
  { name: "宝剑", symbol: "⚔️", from: "#1e293b", via: "#475569", to: "#94a3b8" },
  { name: "星币", symbol: "🪙", from: "#052e16", via: "#166534", to: "#65a30d" },
] as const

const MINOR_RANKS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "侍从", "骑士", "王后", "国王"]

export interface MockCard {
  name: string
  suit: string | null
  symbol: string
  from: string
  via: string
  to: string
}

/** 78 张牌（22 大阿卡纳 + 4 花色 × 14 小阿卡纳），顺序与生产骨架一致 */
export const MOCK_CARDS: MockCard[] = [
  ...MAJOR_ARCANA.map<MockCard>((name) => ({
    name,
    suit: null,
    symbol: "✦",
    from: "#1e1b4b",
    via: "#4c1d95",
    to: "#a21caf",
  })),
  ...SUITS.flatMap((suit) =>
    MINOR_RANKS.map<MockCard>((rank) => ({
      name: `${suit.name}${rank}`,
      suit: suit.name,
      symbol: suit.symbol,
      from: suit.from,
      via: suit.via,
      to: suit.to,
    })),
  ),
]

/** 内联 SVG 占位图（3:4；framed = 带装饰边框的合成成品样式） */
export function mockCardImageUrl(index: number, framed = false): string {
  const card = MOCK_CARDS[index] ?? MOCK_CARDS[0]!
  const border = framed
    ? `<rect x="22" y="22" width="556" height="756" rx="26" fill="none" stroke="rgba(255,255,255,.6)" stroke-width="5"/>
       <rect x="38" y="38" width="524" height="724" rx="18" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="1.5"/>`
    : ""
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${card.from}"/><stop offset=".55" stop-color="${card.via}"/><stop offset="1" stop-color="${card.to}"/>
  </linearGradient></defs>
  <rect width="600" height="800" fill="url(#g)"/>
  <circle cx="300" cy="320" r="150" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="2.5"/>
  <circle cx="300" cy="320" r="118" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="1.5"/>
  ${border}
  <text x="300" y="368" font-size="140" text-anchor="middle">${card.symbol}</text>
  <text x="300" y="620" font-size="46" fill="rgba(255,255,255,.94)" text-anchor="middle" font-family="serif" font-weight="600">${card.name}</text>
  <text x="300" y="688" font-size="22" fill="rgba(255,255,255,.45)" text-anchor="middle">UI 预览占位 · ${String(index + 1).padStart(2, "0")}/78${framed ? " · 含边框" : ""}</text>
</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`.replace(/"/g, "'")
}

// ---------------------------------------------------------------------------
// 文案占位
// ---------------------------------------------------------------------------

const MOCK_PROMPT =
  "想要一套「星月暗夜」主题的塔罗牌：深蓝紫夜空、手绘水彩质感、点缀金色星尘，整体神秘但不阴森，适合送礼与收藏。"

const MOCK_BRIEF = `【主题与世界观】
星月暗夜：一座悬浮于夜空中的占星台，星轨与月相是贯穿全套的视觉母题。

【目标受众】
成年人 · 礼物赠送与个人收藏为主，兼顾轻度占卜使用。

【艺术媒介】
手绘水彩 + 金色勾线点缀；纸面留出细微纹理。

【色彩体系】
主色：午夜蓝紫（深靛 → 暗紫渐变）；辅色：星尘金、月白高光。

【构图惯例】
主体居中、满幅出血，四边预留安全边距；人物与场景 6:4 交替。

【边框与排版】
AI 融合细金线边框（预览占位说明：不含任何文字与编号）。

【牌盒形态】
立式书型盒，正面主视觉 + 侧面星轨纹样。

【负面清单】
不出现文字、编号、尺寸标注；避免可爱卡通化倾向。`

function mockDirections(): AgentTemplateDirection[] {
  return [
    {
      id: "dir-stargazer",
      name: "星轨观测者",
      description: "占星台上的观测者俯瞰星轨流转，宏大而宁静的夜空叙事。",
      concept: "把整副牌做成一座夜空中的占星档案馆",
      worldview:
        "（占位）每张牌都是占星台档案库里的一页手绘记录：星轨在头顶流转，观测者以水彩与金线记录每一次月相变化。",
      majorArcana: "（占位）大阿卡纳演绎为占星台历代守护者的关键时刻，如「愚者」是初登台顶的年轻观测者。",
      suitMapping: [
        { suit: "权杖", mapping: "（占位）流星与火炬的光轨" },
        { suit: "圣杯", mapping: "（占位）承接月光的银杯" },
        { suit: "宝剑", mapping: "（占位）划分星区的罗盘针" },
        { suit: "星币", mapping: "（占位）刻着星图的金币" },
      ],
      palette: "午夜蓝紫为主，星尘金与月白高光为辅",
      visualLanguage: "手绘水彩、金线勾边、颗粒星尘、深色底高对比",
      sampleCards: [
        { name: "星星", scene: "（占位）观测者伸手接住坠落的星光" },
        { name: "月亮", scene: "（占位）双塔之间升起满月，水面倒映星轨" },
        { name: "星币三", scene: "（占位）三名工匠共同雕刻星图石板" },
      ],
    },
    {
      id: "dir-tidecaller",
      name: "月潮吟游",
      description: "月光牵引海洋潮汐，海洋与夜空交织的抒情叙事。",
      concept: "以「月引潮生」贯穿 78 张牌的情绪曲线",
      worldview: "（占位）潮汐随月相涨落，吟游诗人沿海岸线收集月光凝成的贝壳。",
      majorArcana: "（占位）大阿卡纳对应一次完整的月相周期。",
      suitMapping: [
        { suit: "权杖", mapping: "（占位）灯塔与篝火" },
        { suit: "圣杯", mapping: "（占位）盛满潮水的螺壳" },
        { suit: "宝剑", mapping: "（占位）风中竖立的船桅" },
        { suit: "星币", mapping: "（占位）海底捞起的旧钱币" },
      ],
      palette: "靛青与珍珠白，浪尖点缀银光",
      visualLanguage: "湿画法水彩、流动笔触、海雾朦胧",
      sampleCards: [
        { name: "死神", scene: "（占位）退潮后显露的新月形沙滩" },
        { name: "节制", scene: "（占位）两只杯子间流动的水光" },
        { name: "圣杯王后", scene: "（占位）王后凝望海面倒映的月亮" },
      ],
    },
    {
      id: "dir-nightmarket",
      name: "午夜星市",
      description: "只在午夜开市的漂浮集市，人间烟火与星光的混搭。",
      concept: "神秘但不阴森：热闹的夜市摊位各有神明与旅人驻足",
      worldview: "（占位）集市悬浮于云海之上，摊主是各类星象精灵，货品是被封存的梦境。",
      majorArcana: "（占位）大阿卡纳是集市里的二十二家老铺。",
      suitMapping: [
        { suit: "权杖", mapping: "（占位）集市灯笼与火把" },
        { suit: "圣杯", mapping: "（占位）甜酒与占卜茶摊" },
        { suit: "宝剑", mapping: "（占位）铁匠铺的风向标" },
        { suit: "星币", mapping: "（占位）星尘铸币的钱庄" },
      ],
      palette: "暖金灯火压住蓝紫夜色",
      visualLanguage: "水彩 + 版画线条、暖冷对比、细节密集",
      sampleCards: [
        { name: "恋人", scene: "（占位）两人在灯下交换信物" },
        { name: "命运之轮", scene: "（占位）集市的旋转木马星盘" },
        { name: "权杖九", scene: "（占位）守夜人举灯戒备的摊位街" },
      ],
    },
  ]
}

const CLARIFY_ROUND1: AgentClarifyQuestion[] = [
  { id: "q1-1", question: "这副牌的主要使用场景是？", options: ["礼物赠送", "商用售卖", "个人收藏", "占卜实践"] },
  { id: "q1-2", question: "目标受众偏向哪类人群？", options: ["青少年", "成年人", "全年龄", "专业占卜师"] },
  { id: "q1-3", question: "艺术媒介上更偏好哪种质感？", options: ["手绘水彩", "厚涂油画", "扁平插画", "3D 渲染"] },
]

const CLARIFY_ROUND2: AgentClarifyQuestion[] = [
  { id: "q2-1", question: "边框装饰希望走什么方向？", options: ["细金线古典边框", "无框满幅", "几何装饰边框", "植物藤蔓纹样"] },
  { id: "q2-2", question: "牌盒形态有偏好吗？", options: ["立式书型盒", "抽屉式盒", "天地盖盒", "听设计师安排"] },
]

// ---------------------------------------------------------------------------
// 主构建器
// ---------------------------------------------------------------------------

/** 各阶段 running / error 时的待执行动作 */
function pendingActionFor(stage: PreviewStage, phase: "sample" | "full"): AgentPendingAction {
  const requestedAt = minutesAgo(1).toISOString()
  switch (stage) {
    case "clarify":
      return { kind: "clarify_turn", requestedAt }
    case "world":
      return { kind: "gen_directions", requestedAt }
    case "prompt":
      return { kind: "produce_cards", phase: "sample", requestedAt }
    case "art":
      return { kind: "produce_cards", phase, requestedAt }
    case "compose":
      return { kind: "compose_batch", requestedAt }
  }
}

/** 按阶段生成 78 张卡面（未到 prompt 阶段时为空清单，与真实流程一致） */
function buildItems(stage: PreviewStage, status: PreviewStatus): WorkspaceItem[] {
  if (stage === "clarify" || stage === "world") return []

  const cards = MOCK_CARDS.map((card, index) => {
    const id = `preview-item-${index}`
    const isSample = SAMPLE_INDEXES.includes(index)
    const base = {
      id,
      index,
      name: card.name,
      meaning: `（占位牌义）${card.name}：星月暗夜主题下的演绎要点 ${index + 1}。`,
      visualBrief: `（占位画面）手绘水彩，午夜蓝紫底，${card.suit ?? "大阿卡纳"}母题居中，星尘金勾边。`,
      currentPrompt: `（占位提示词）watercolor tarot card, ${card.name}, night sky, gold accents, no text`,
      status: "pending" as WorkspaceItem["status"],
      isSample,
      roundsUsed: 0,
      finalRoundId: null as string | null,
      fallbackContentWarning: false,
      manualRegenCount: 0,
      errorMessage: null as string | null,
      framedImageUrl: null as string | null,
      frameStatus: null as WorkspaceItem["frameStatus"],
      latestRoundId: null as string | null,
      latestRoundNumber: null as number | null,
      latestImageUrl: null as string | null,
    }
    return base
  })

  if (stage === "prompt") return cards

  // art（等待 = 小样收口）/ compose（全套完成 + 融合）
  const artWaiting = stage === "art" && status === "waiting_human"
  for (const [i, item] of cards.entries()) {
    if (artWaiting) {
      if (!item.isSample) continue
      if (i === 21) {
        item.status = "failed"
        item.errorMessage = "（占位）生图超时：模型服务繁忙，可重试"
        item.roundsUsed = 2
      } else if (i === 10) {
        item.status = "fallback"
        item.finalRoundId = `${item.id}-r1`
        item.latestRoundId = `${item.id}-r1`
        item.latestRoundNumber = 1
        item.latestImageUrl = mockCardImageUrl(i)
        item.roundsUsed = 3
        item.fallbackContentWarning = true
      } else {
        item.status = "approved_by_ai"
        item.finalRoundId = `${item.id}-r1`
        item.latestRoundId = `${item.id}-r1`
        item.latestRoundNumber = 1
        item.latestImageUrl = mockCardImageUrl(i)
      }
    } else {
      // art 进行中/失败 与 compose：全套口径
      if (i < 30) {
        item.status = i === 7 ? "fallback" : "confirmed"
        item.finalRoundId = `${item.id}-r2`
        item.latestRoundId = `${item.id}-r2`
        item.latestRoundNumber = 2
        item.latestImageUrl = mockCardImageUrl(i)
        item.roundsUsed = i === 7 ? 3 : i % 4 === 0 ? 2 : 1
        item.fallbackContentWarning = i === 7
      } else if (i < 36) {
        item.status = i % 2 === 0 ? "generating" : "reviewing"
        item.latestRoundId = null
        item.latestImageUrl = null
      } else if (i === 36 && status === "error") {
        item.status = "failed"
        item.errorMessage = "（占位）生图连续失败：上游模型超时"
        item.roundsUsed = 2
      } else if (i >= 36) {
        item.status = "pending"
      }
    }
  }

  if (stage === "compose") {
    // 交付视角：全部确认 + AI 融合完成
    for (const [i, item] of cards.entries()) {
      item.status = "confirmed"
      item.finalRoundId = `${item.id}-r2`
      item.latestRoundId = `${item.id}-r2`
      item.latestRoundNumber = 2
      item.latestImageUrl = mockCardImageUrl(i)
      item.frameStatus = i === 77 && status === "error" ? "failed" : "framed"
      item.framedImageUrl = item.frameStatus === "framed" ? mockCardImageUrl(i, true) : null
    }
  }
  return cards
}

function buildEvents(stage: PreviewStage, status: PreviewStatus): WorkspaceData["events"] {
  const events: WorkspaceData["events"] = []
  const push = (
    id: string,
    nodeKey: string | null,
    action: string,
    statusText: string,
    detail: string,
    minutes: number,
  ) => events.push({ id, runId: RUN_ID, nodeKey, nodeType: "agent", action, status: statusText, detail, itemId: null, roundId: null, createdAt: minutesAgo(minutes) })

  push("ev-1", "creative_director", "start", "ok", "开始主持需求澄清", 62)
  push("ev-2", "creative_director", "done", "ok", "第 1 轮追问已发出（3 个问题）", 61)
  push("ev-3", "creative_director", "done", "ok", "第 2 轮追问已发出（2 个问题）", 44)
  if (stage !== "clarify") {
    push("ev-4", "creative_director", "done", "ok", "《设计简报》已生成，等待用户确认", 30)
    if (status === "running" && stage === "world") {
      push("ev-5", "world_planner", "start", "ok", "开始构思 3 个内容方向", 12)
    } else {
      push("ev-5", "world_planner", "done", "ok", "已产出 3 个内容方向", 20)
    }
  }
  if (stage !== "clarify" && stage !== "world") {
    push("ev-6", "world_planner", "confirm", "ok", "内容方向「星轨观测者」已确认", 18)
    push("ev-7", "prompt_designer", "done", "ok", "78 张卡牌清单已生成（牌义 + 画面构想）", 17)
  }
  if (stage === "art" || stage === "compose") {
    if (status === "running" && stage === "art") {
      push("ev-8", "artist", "start", "ok", "全套生产进行中：文案改写 → 生图 → 三审 → 裁决", 8)
    } else {
      push("ev-8", "artist", "done", "ok", "风格小样 6 张已生成（5 成功 · 1 兜底）", 12)
      push("ev-9", "review_panel", "done", "ok", "已评审 34 张卡面（三审并行）", 9)
      push("ev-10", "supervisor", "done", "ok", "裁决 34 次：放行 33 · 打回 1", 9)
    }
  }
  if (stage === "compose") {
    push("ev-11", "artist", "confirm", "ok", "78 张卡面全部确认终版", 6)
    push("ev-12", "compositor", status === "error" ? "fail" : "done", status === "error" ? "error" : "ok",
      status === "error" ? "AI 融合第 78 张连续失败（占位错误信息）" : "AI 融合边框批量完成 78/78", 3)
  }
  if (status === "error") {
    push("ev-13", stage === "compose" ? "compositor" : "artist", "fail", "error", "执行失败（占位）：上游生图服务超时，动作已保留可重试", 2)
  }
  return events
}

function buildMessages(stage: PreviewStage, status: PreviewStatus): WorkspaceData["messages"] {
  const messages: WorkspaceData["messages"] = []
  const push = (
    id: string,
    role: "user" | "assistant",
    content: string,
    nodeKey: string | null,
    meta: WorkspaceData["messages"][number]["meta"],
    minutes: number,
  ) => messages.push({ id, runId: RUN_ID, role, content, nodeKey, meta, itemId: null, createdAt: minutesAgo(minutes) })

  push("msg-1", "user", MOCK_PROMPT, "creative_director", null, 63)
  push(
    "msg-2",
    "assistant",
    "收到你的想法！我先确认几个关键点：这副牌的使用场景、目标受众和媒介质感。",
    "creative_director",
    { kind: "clarify", round: 1, analysis: "（占位分析）用户已给出主题与氛围偏好，但使用场景、受众与媒介尚不明确。", questions: CLARIFY_ROUND1, ready: false },
    62,
  )
  push(
    "msg-3",
    "user",
    "这副牌主要的使用场景是？：礼物赠送\n目标受众偏向哪类人群？：成年人\n艺术媒介上更偏好哪种质感？：手绘水彩",
    "creative_director",
    null,
    45,
  )

  if (stage === "clarify" && status === "running") return messages

  push(
    "msg-4",
    "assistant",
    "很好，方向清晰多了。最后两个小问题：边框与牌盒。",
    "creative_director",
    { kind: "clarify", round: 2, analysis: "（占位分析）核心决策已齐备，剩余边框与牌盒形态可用默认取向收口。", questions: CLARIFY_ROUND2, ready: true },
    44,
  )

  if (stage === "clarify") return messages

  push(
    "msg-5",
    "user",
    "边框装饰希望走什么方向？：细金线古典边框\n牌盒形态有偏好吗？：立式书型盒",
    "creative_director",
    null,
    32,
  )
  push("msg-6", "assistant", "《设计简报》已生成，请在弹窗中查看、修改并确认。", "creative_director", { kind: "brief" }, 30)

  if (stage === "world") {
    // world 进行中：方向尚未产出（骨架屏）；等待/失败：已产出 3 个方向
    if (status !== "running") {
      push("msg-7", "assistant", "我根据简报构思了 3 个内容方向，请选择一个。", "world_planner", { kind: "directions", count: 3 }, 20)
    }
    return messages
  }

  push("msg-7", "assistant", "我根据简报构思了 3 个内容方向，请选择一个。", "world_planner", { kind: "directions", count: 3 }, 20)
  return messages
}

function buildAssets(stage: PreviewStage): WorkspaceData["assets"] {
  if (stage === "clarify" || stage === "world" || stage === "prompt") return []
  const kinds: { kind: WorkspaceData["assets"][number]["kind"]; label: string; confirmed: boolean }[] = [
    { kind: "border", label: "透明边框 · 金线古典", confirmed: true },
    { kind: "back", label: "卡背 · 星轨纹样", confirmed: true },
    { kind: "box_front", label: "牌盒正面", confirmed: stage === "compose" },
    { kind: "box_back", label: "牌盒背面", confirmed: stage === "compose" },
    { kind: "box_side", label: "牌盒侧面", confirmed: stage === "compose" },
    { kind: "box_top", label: "牌盒顶面", confirmed: stage === "compose" },
  ]
  return kinds.map((item, i) => ({
    id: `preview-asset-${item.kind}`,
    runId: RUN_ID,
    kind: item.kind,
    name: item.label,
    url: mockCardImageUrl([0, 8, 2, 16, 26, 36][i] ?? i, item.kind === "border"),
    meta: { status: item.confirmed ? "confirmed" : "uploaded", source: "agent", prompt: "（占位）资产提示词", confirmedAt: item.confirmed ? minutesAgo(10).toISOString() : null },
    createdAt: minutesAgo(16 - i),
  }))
}

export function buildMockTarotWorkspace(stage: PreviewStage, status: PreviewStatus): WorkspaceData {
  const items = buildItems(stage, status)
  const phase: "sample" | "full" =
    stage === "compose" || (stage === "art" && status !== "waiting_human") || (stage === "prompt" && status !== "waiting_human")
      ? "full"
      : "sample"
  const pendingAction =
    status === "waiting_human"
      ? null
      : pendingActionFor(stage, stage === "prompt" ? "sample" : phase)
  const directions = stage === "clarify" ? [] : mockDirections()
  const statusCounts = new Map<string, number>()
  for (const item of items) statusCounts.set(item.status, (statusCounts.get(item.status) ?? 0) + 1)

  const run: WorkspaceRun = {
    id: RUN_ID,
    direction: "tarot",
    enterpriseId: ENTERPRISE_ID,
    userId: USER_ID,
    status: status === "error" ? "failed" : status,
    phase,
    input: {
      prompt: MOCK_PROMPT,
      cardCount: 78,
      concurrency: 2,
      referenceImages: [mockCardImageUrl(3), mockCardImageUrl(17)],
      quality: { contentThreshold: 80, aestheticThreshold: 80, consistencyThreshold: 70, maxRetries: 2 },
    },
    graphSnapshot: { nodes: [], edges: [] } as unknown as WorkspaceRun["graphSnapshot"],
    styleDoc: null,
    template: "tarot",
    stage,
    title: "【预览】星月暗夜塔罗 · 全套 78 张",
    brief: stage === "clarify" ? (status === "waiting_human" ? MOCK_BRIEF : null) : MOCK_BRIEF,
    pendingAction,
    directions,
    selectedDirection: stage === "clarify" || stage === "world" ? null : "tarot",
    selectedDirectionId: stage === "clarify" || stage === "world" ? null : "dir-stargazer",
    frameMode: "ai",
    frameAssetId: stage === "compose" ? "preview-asset-border" : null,
    costCenticredits: 18_900,
    unbilledCenticredits: 0,
    imageCostCredits: 234,
    imageCount: 96,
    llmCallCount: 142,
    error:
      status === "error"
        ? "（占位错误）上游生图服务超时：「" +
          (stage === "compose" ? "AI 融合批量" : "卡面生产") +
          "」执行失败，动作已保留，可一键重试。"
        : null,
    startedAt: minutesAgo(63),
    finishedAt: null,
    createdAt: minutesAgo(63),
    updatedAt: minutesAgo(1),
  }

  return {
    run,
    messages: buildMessages(stage, status),
    assets: buildAssets(stage),
    items,
    itemStats: [...statusCounts.entries()].map(([status, count]) => ({ status, count })),
    events: buildEvents(stage, status),
    // 模板流程不落 agent_node_run 行（节点看板由 deriveClassicNodeBoard 推导）
    nodes: [],
  }
}

// ---------------------------------------------------------------------------
// 读操作 mock（评分聚合 / 交付物 / 单卡详情 / 资产提示词）
// ---------------------------------------------------------------------------

export function mockDeckScores(stage: PreviewStage): Awaited<ReturnType<typeof getTarotDeckScoresAction>> {
  if (stage === "clarify" || stage === "world" || stage === "prompt") {
    return { items: [], contentPass: 0, contentTotal: 0, thresholds: { aesthetic: 75, consistency: 70 }, sampled: 0 }
  }
  const sampled = 24
  const items = Array.from({ length: sampled }, (_, i) => ({
    content: null,
    aesthetic: 64 + ((i * 7) % 33),
    consistency: 66 + ((i * 5) % 31),
  }))
  return {
    items,
    contentPass: 21,
    contentTotal: sampled,
    thresholds: { aesthetic: 75, consistency: 70 },
    sampled,
  }
}

export function mockDeliverables(data: WorkspaceData): Awaited<ReturnType<typeof getTarotDeliverablesAction>> {
  const cards = data.items.map((item) => ({
    id: item.id,
    index: item.index,
    name: item.name,
    status: item.status,
    frameStatus: item.frameStatus,
    finalImage: item.framedImageUrl ?? item.latestImageUrl ?? null,
  }))
  const assetLabels: Record<string, string> = {
    border: "透明边框",
    back: "卡背",
    box_front: "牌盒正面",
    box_back: "牌盒背面",
    box_side: "牌盒侧面",
    box_top: "牌盒顶面",
  }
  const assets = (["border", "back", "box_front", "box_back", "box_side", "box_top"] as const).map((kind) => {
    const asset = data.assets.find((candidate) => candidate.kind === kind)
    return {
      kind,
      label: assetLabels[kind] ?? kind,
      url: asset?.url ?? "",
      confirmed: (asset?.meta as { status?: string } | null)?.status === "confirmed",
    }
  })
  const files = [
    ...cards
      .filter((card) => card.finalImage)
      .map((card) => ({
        id: card.id,
        filename: `cards/${String(card.index + 1).padStart(2, "0")}-${card.name ?? `第${card.index + 1}张`}.png`,
        title: card.name ?? `第 ${card.index + 1} 张`,
        kind: "card" as const,
        url: card.finalImage!,
      })),
    ...assets
      .filter((asset) => asset.url)
      .map((asset) => ({
        id: asset.kind,
        filename: `assets/${asset.kind}.png`,
        title: asset.label,
        kind: asset.kind,
        url: asset.url,
      })),
  ]
  return {
    cards,
    assets,
    files,
    readyCount: files.length,
    totalCount: cards.length + assets.length,
  }
}

/** 单卡逐轮回放详情：2 轮（第 1 轮打回、第 2 轮放行为终版）+ 三审 + 裁决 */
export function mockItemDetail(itemId: string, data: WorkspaceData): Awaited<ReturnType<typeof getRunItemDetailAction>> {
  const item = data.items.find((candidate) => candidate.id === itemId) ?? data.items[0]
  if (!item) {
    return {
      item: {
        id: itemId,
        index: 0,
        name: null,
        meaning: null,
        status: "pending",
        isSample: false,
        roundsUsed: 0,
        finalRoundId: null,
        fallbackContentWarning: false,
        manualRegenCount: 0,
        errorMessage: null,
      },
      rounds: [],
      reviews: [],
      thresholds: { content: 80, aesthetic: 75, consistency: 70 },
    }
  }
  const imageUrl = item.latestImageUrl ?? mockCardImageUrl(item.index)
  type Detail = Awaited<ReturnType<typeof getRunItemDetailAction>>
  const rounds: Detail["rounds"] = [
    {
      id: `${item.id}-r1`,
      runId: RUN_ID,
      itemId: item.id,
      roundNumber: 1,
      prompt: `（占位）第 1 轮提示词：watercolor tarot, ${item.name}, night sky, gold accents, no text`,
      promptSource: "initial" as const,
      imageUrl,
      generationMeta: null,
      candidates: [
        { url: imageUrl, score: 71, contentPass: true },
        { url: mockCardImageUrl((item.index + 1) % 78), score: 64, contentPass: null },
      ],
      costCredits: 1,
      createdAt: minutesAgo(40),
    },
    {
      id: `${item.id}-r2`,
      runId: RUN_ID,
      itemId: item.id,
      roundNumber: 2,
      prompt: `（占位）第 2 轮提示词（按审核反馈改写）：加强主体辨识度，统一金线粗细`,
      promptSource: "auto_revise" as const,
      imageUrl: mockCardImageUrl(item.index, true),
      generationMeta: null,
      candidates: [{ url: imageUrl, score: null, contentPass: null }],
      costCredits: 1,
      createdAt: minutesAgo(35),
    },
  ]
  const reviews: Detail["reviews"] = [
    {
      id: `${item.id}-rv-r1-c`,
      runId: RUN_ID,
      itemId: item.id,
      roundId: rounds[0]!.id,
      nodeKey: "review_1",
      kind: "review",
      result: { dimension: "content", pass: false, score: null, reason: "（占位）主体偏小，牌义传达不够直接，建议放大并居中。" },
      createdAt: minutesAgo(39),
    },
    {
      id: `${item.id}-rv-r1-a`,
      runId: RUN_ID,
      itemId: item.id,
      roundId: rounds[0]!.id,
      nodeKey: "review_2",
      kind: "review",
      result: { dimension: "aesthetic", pass: null, score: 71, reason: "（占位）色彩氛围到位，但金线细节略糙。" },
      createdAt: minutesAgo(39),
    },
    {
      id: `${item.id}-rv-r1-v`,
      runId: RUN_ID,
      itemId: item.id,
      roundId: rounds[0]!.id,
      nodeKey: "supervisor",
      kind: "verdict",
      result: {
        verdict: "retry",
        contentPass: false,
        aestheticScore: 71,
        consistencyScore: 74,
        roundsUsed: 1,
        maxRetries: 2,
        detail: "（占位）内容审未过，打回改写：放大主体、金线统一为 1.5pt。",
      },
      createdAt: minutesAgo(38),
    },
    {
      id: `${item.id}-rv-r2-a`,
      runId: RUN_ID,
      itemId: item.id,
      roundId: rounds[1]!.id,
      nodeKey: "review_2",
      kind: "review",
      result: { dimension: "aesthetic", pass: null, score: 86, reason: "（占位）改写后主体清晰，金线质感统一。" },
      createdAt: minutesAgo(34),
    },
    {
      id: `${item.id}-rv-r2-c`,
      runId: RUN_ID,
      itemId: item.id,
      roundId: rounds[1]!.id,
      nodeKey: "review_1",
      kind: "review",
      result: { dimension: "content", pass: true, score: null, reason: "（占位）画面与牌义对齐。" },
      createdAt: minutesAgo(34),
    },
    {
      id: `${item.id}-rv-r2-s`,
      runId: RUN_ID,
      itemId: item.id,
      roundId: rounds[1]!.id,
      nodeKey: "review_3",
      kind: "review",
      result: { dimension: "consistency", pass: null, score: 82, reason: "（占位）与风格基准图色调一致。" },
      createdAt: minutesAgo(34),
    },
    {
      id: `${item.id}-rv-r2-v`,
      runId: RUN_ID,
      itemId: item.id,
      roundId: rounds[1]!.id,
      nodeKey: "supervisor",
      kind: "verdict",
      result: {
        verdict: "approve",
        contentPass: true,
        aestheticScore: 86,
        consistencyScore: 82,
        roundsUsed: 2,
        maxRetries: 2,
        detail: "（占位）三审通过，选为终版。",
      },
      createdAt: minutesAgo(33),
    },
  ]
  return {
    item: {
      id: item.id,
      index: item.index,
      name: item.name,
      meaning: item.meaning,
      status: item.status,
      isSample: item.isSample,
      roundsUsed: item.roundsUsed,
      // 详情内以第 2 轮（放行轮）为终版，保证回放弹窗自身叙事一致；
      // 失败卡无终版
      finalRoundId: item.status === "failed" ? null : rounds[1]!.id,
      fallbackContentWarning: item.fallbackContentWarning,
      manualRegenCount: item.manualRegenCount,
      errorMessage: item.errorMessage,
    },
    rounds,
    reviews,
    thresholds: { content: 80, aesthetic: 75, consistency: 70 },
  }
}

export function mockAssetPrompts(): { kind: AgentAssetKind; prompt: string }[] {
  const entries = [
    { kind: "border" as const, prompt: "（占位）透明卡牌边框：细金线古典纹样，四角星尘点缀，PNG 透明底，不含文字。" },
    { kind: "back" as const, prompt: "（占位）卡背：星轨罗盘对称纹样，午夜蓝紫底 + 金线，中央新月徽记。" },
    { kind: "box_front" as const, prompt: "（占位）牌盒正面：主视觉同款观测者仰望星轨，立式书型盒比例。" },
    { kind: "box_back" as const, prompt: "（占位）牌盒背面：星图密铺纹样 + 中央简介区（留白）。" },
    { kind: "box_side" as const, prompt: "（占位）牌盒侧面：连续星轨横纹，金线压边。" },
    { kind: "box_top" as const, prompt: "（占位）牌盒顶面：新月徽记 + 四向星尘。" },
  ]
  return entries
}
