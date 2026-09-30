/**
 * 塔罗牌模板（卡牌模板注册表 · 首条产品线）
 *
 * 面向「成套卡牌设计」场景的完整创作规格：固定元数据 + 五阶段流程 +
 * 七角色编制 + 交付物清单（78 卡 + 边框/牌背/牌盒四视图）+ 澄清清单 +
 * 提示词守则 + 78 张卡牌骨架。
 *
 * 结构契约：
 * - 卡牌骨架包装自 ../pipelines 的 tarotSkeleton()，顺序与牌名严格一致，
 *   本文件不重复定义牌名（单一事实来源）；
 * - 卡面画面禁止边框 / 文字 / 编号 / 尺寸标注 —— 这些由合成阶段统一叠加
 *   （守则见 TAROT_GUARDRAILS，负面提示词拼接见 TAROT_CARD_ART_NEGATIVE_PROMPT）；
 * - 通用类型（DeckTemplate 系列）声明在 ./index，本文件只做塔罗的字面量收窄与数据；
 * - 纯数据 + 纯函数，零运行时依赖（不含 DB / 网络请求）。
 */
import { sampleIndexes, tarotSkeleton } from "../pipelines"
import type { AgentRole } from "../graph"
import type {
  AssetPromptRule,
  ClarificationSection,
  DeckCardSkeleton,
  DeckTemplate,
  DeckTemplateDeliverable,
  DeckTemplateMeta,
  DeckTemplateRole,
  DeckTemplateStage,
  DeliverableKind,
  PromptGuardrail,
} from "./index"

// ---------------------------------------------------------------------------
// 固定常量
// ---------------------------------------------------------------------------

/** 标准塔罗张数：22 大阿卡纳 + 56 小阿卡纳 */
export const TAROT_CARD_COUNT = 78
export const TAROT_MAJOR_COUNT = 22
export const TAROT_MINOR_COUNT = 56

/** 模板固定五阶段数（澄清 → 世界观 → 提示词 → 生图评审 → 合成交付） */
export const TAROT_STAGE_COUNT = 5

/** 小阿卡纳花色（顺序与 pipelines.tarotSkeleton 的出牌顺序一致） */
export const TAROT_SUIT_ORDER = ["权杖", "圣杯", "宝剑", "星币"] as const
export type TarotSuit = (typeof TAROT_SUIT_ORDER)[number]

export type TarotArcana = "major" | "minor"

export type TarotStageId = "clarify" | "world" | "prompt" | "art" | "compose"

/** 七角色编制（模板层职责命名；引擎映射见 TarotRole.engineRole/engineNodeType） */
export type TarotRoleId =
  | "creative_director"
  | "world_planner"
  | "prompt_designer"
  | "artist"
  | "review_panel"
  | "compositor"
  | "supervisor"

// ---------------------------------------------------------------------------
// 类型收窄（在 ./index 通用接口基础上把 id 类字段落成字面量联合）
// ---------------------------------------------------------------------------

export interface TarotTemplateMeta extends DeckTemplateMeta {
  key: "tarot"
}

export interface TarotStage extends DeckTemplateStage {
  id: TarotStageId
  roleIds: TarotRoleId[]
}

export interface TarotRole extends DeckTemplateRole {
  id: TarotRoleId
  /** 对应流水线编制角色（graph.AgentRole）；无对应时为 null */
  engineRole: AgentRole | null
}

export interface TarotDeliverable extends DeckTemplateDeliverable {
  stageId: TarotStageId
}

export interface TarotAssetRule extends AssetPromptRule {
  /** 套件资产类型（card 逐卡走卡面守则，不在此列） */
  deliverableKind: Exclude<DeliverableKind, "card">
}

export interface TarotCardSkeleton extends DeckCardSkeleton {
  arcana: TarotArcana
  /** 小阿卡纳花色；大阿卡纳为 null */
  suit: TarotSuit | null
  /** 小阿卡纳牌阶 1-14（王牌=1 … 国王=14）；大阿卡纳为 null */
  rank: number | null
}

export interface TarotTemplate extends DeckTemplate {
  meta: TarotTemplateMeta
  stages: TarotStage[]
  roles: TarotRole[]
  deliverables: TarotDeliverable[]
  clarification: ClarificationSection[]
  guardrails: PromptGuardrail[]
  assetRules: TarotAssetRule[]
  cards: TarotCardSkeleton[]
}

// ---------------------------------------------------------------------------
// 元数据
// ---------------------------------------------------------------------------

export const TAROT_META: TarotTemplateMeta = {
  key: "tarot",
  name: "塔罗牌全套设计",
  version: "1.0.0",
  description:
    "标准 78 张塔罗（22 大阿卡纳 + 56 小阿卡纳）+ 边框/牌背/牌盒套件资产，五阶段流水线产出可直接印刷的全套设计稿（共 84 项交付物）。",
  cardCount: TAROT_CARD_COUNT,
  // 小样代表卡：愚者 / 魔术师 / 女祭司 / 恋人 / 命运之轮 / 世界
  sampleIndexes: sampleIndexes("tarot", TAROT_CARD_COUNT, 6),
}

// ---------------------------------------------------------------------------
// 五阶段流程
// ---------------------------------------------------------------------------

export const TAROT_STAGES: TarotStage[] = [
  {
    id: "clarify",
    order: 1,
    name: "需求澄清",
    goal: "把模糊的创作愿望收敛为一组可执行、可复核的创作决策。",
    roleIds: ["creative_director"],
    inputs: ["用户创作提示词", "风格参考图（≤4 张）"],
    outputs: ["澄清结论（澄清清单逐条答案）", "创作要点简报"],
    exitCriteria: ["必答项全部有明确答案或采用默认取向", "结论与参考图风格不冲突"],
  },
  {
    id: "world",
    order: 2,
    name: "世界观与风格定稿",
    goal: "产出统摄整套牌的风格规范书与 78 张卡牌清单。",
    roleIds: ["world_planner", "creative_director"],
    inputs: ["澄清结论", "风格参考图"],
    outputs: ["风格规范书（媒介/色调/构图/光影/负面清单）", "78 张卡牌清单（严格按骨架逐张补全牌义）"],
    exitCriteria: ["清单恰好 78 张且牌名与骨架逐一对应", "每张卡有一句话牌义且彼此不重复"],
  },
  {
    id: "prompt",
    order: 3,
    name: "提示词设计",
    goal: "逐张把牌义转写为可生图的提示词，并为套件资产定稿提示词。",
    roleIds: ["prompt_designer"],
    inputs: ["风格规范书", "卡牌清单", "卡面守则（TAROT_GUARDRAILS）", "资产提示词规则（TAROT_ASSET_RULES）"],
    outputs: ["78 条卡面生图提示词", "6 条套件资产提示词（边框/牌背/牌盒四视图）"],
    exitCriteria: [
      "每条卡面提示词通过守则自检（无边框/无文字/无编号/无尺寸标注）",
      "套件资产提示词与资产提示词规则骨架一致",
    ],
  },
  {
    id: "art",
    order: 4,
    name: "生图与评审",
    goal: "按提示词产出全部画面，并通过三审裁决循环。",
    roleIds: ["artist", "review_panel", "supervisor"],
    inputs: ["卡面/资产提示词", "风格参考图", "审核及格线"],
    outputs: ["78 张过审卡面图", "6 个过审套件资产图"],
    exitCriteria: ["内容对齐/审美/成套一致性三审通过", "打回耗尽时按历史最优兜底放行"],
  },
  {
    id: "compose",
    order: 5,
    name: "合成交付",
    goal: "把过审素材装配为可直接印刷的全套交付物。",
    roleIds: ["compositor", "supervisor"],
    inputs: ["过审卡面图", "边框/牌背/牌盒资产", "排版语言决策（澄清结论）"],
    outputs: ["78 张成品卡（边框叠加 + 牌名/编号排版）", "牌盒四视图成品稿", "交付清单（共 84 项）"],
    exitCriteria: ["交付清单逐项齐全且与交付物定义一致", "文字与装饰不遮盖卡面主体"],
  },
]

// 阶段数守卫：模板固定五段，误增删在这里第一时间炸出来
if (TAROT_STAGES.length !== TAROT_STAGE_COUNT) {
  throw new Error(`塔罗模板阶段数异常：期望 ${TAROT_STAGE_COUNT} 段，实际 ${TAROT_STAGES.length} 段`)
}

// ---------------------------------------------------------------------------
// 七角色编制
// ---------------------------------------------------------------------------

export const TAROT_ROLES: TarotRole[] = [
  {
    id: "creative_director",
    name: "创意总监",
    group: "planning",
    duty: "主持澄清清单，收敛题材/媒介/色调/边框/牌盒决策，对最终风格负总责",
    systemPrompt:
      "你是资深卡牌创意总监，主持需求澄清并对最终风格负总责。逐条过澄清清单，把用户的模糊偏好收敛为可执行的创作决策：题材世界观、艺术媒介、主辅色、边框装饰、牌背方向、牌盒形态。用户给出参考图时先仔细读图再提问，结论必须与参考图强对齐。输出《澄清结论》与《创作要点简报》，每条要点具体到可直接写进风格规范书。",
    engineNodeType: "agent",
    engineRole: "style",
  },
  {
    id: "world_planner",
    name: "世界观策划",
    group: "planning",
    duty: "产出风格规范书，并严格按骨架逐张补全 78 张牌义",
    systemPrompt:
      "你是卡牌世界观策划师。依据《澄清结论》产出《风格规范书》：艺术风格与媒介、主辅色（给直观色彩描述）、构图与透视惯例、材质笔触、边框装饰语言、光影氛围、负面清单。随后产出 78 张卡牌清单：必须严格按给定骨架的顺序与牌名逐张补全一句话牌义，不得增删或改名；大阿卡纳按塔罗原型意象演绎，小阿卡纳围绕花色元素（权杖-火/圣杯-水/宝剑-风/星币-土）设计彼此可区分的画面意象。",
    engineNodeType: "agent",
    engineRole: "structure",
  },
  {
    id: "prompt_designer",
    name: "提示词设计师",
    group: "planning",
    duty: "逐张撰写生图提示词，并执行卡面守则与资产规则自检",
    systemPrompt:
      "你是卡牌提示词设计师。逐张把《卡牌清单》中的牌名与牌义转写为生图提示词：以风格规范书的视觉语言为前缀，画面具体可画、主体清晰、细节丰富。每条必须自检卡面守则：不画边框、不出现任何文字与编号、不出现尺寸标注、满幅出血构图且主体居中。套件资产（边框/牌背/牌盒）严格按《资产提示词规则》的骨架撰写。打回改写时只针对审核反馈调整，不推翻已通过的部分。",
    engineNodeType: "agent",
    engineRole: "copywriter",
  },
  {
    id: "artist",
    name: "画师",
    group: "production",
    duty: "按提示词与参考图逐张生图（透传参考图作风格引导）",
    systemPrompt:
      "你是卡牌画师，按提示词逐张出图：严格执行风格规范书的媒介、色调与光影；遵守卡面守则——无边框、无文字、无编号、无尺寸标注，满幅出血、主体居中、四边预留安全边距。透传用户参考图作为风格引导。",
    engineNodeType: "image_gen",
    engineRole: null,
  },
  {
    id: "review_panel",
    name: "评审团",
    group: "qa",
    duty: "内容对齐 / 审美评分 / 成套一致性三审并行，打回必附理由",
    systemPrompt:
      "你们是三审评审团。内容审：画面是否准确呈现牌名与牌义，明显偏离不放行；审美审：构图/色彩/细节/执行质量按 0-100 打分，宁严勿宽；一致性审：与风格规范书及基准图比对色调、媒介质感、构图惯例是否成套，明显跳出风格的给低分。每次打回必须给出可执行的具体理由，这是改写的唯一依据。",
    engineNodeType: "review",
    engineRole: null,
  },
  {
    id: "compositor",
    name: "合成师",
    group: "delivery",
    duty: "AI 融合边框 + 交付检查 + 牌盒拼装，产出 84 项交付",
    systemPrompt:
      "你是 AI 融合合成师，负责把过审卡面与透明边框参考图提交给生图模型完成融合，并检查融合结果是否保持边框纹样、透明镂空区域和卡面主体完整；牌盒四视图按参考图成套检查。不要在融合过程中新增文字、牌名、数字或第二层边框。",
    engineNodeType: null,
    engineRole: null,
  },
  {
    id: "supervisor",
    name: "总控",
    group: "control",
    duty: "三审裁决：放行 / 打回改写 / 兜底选优，纯规则不耗模型",
    systemPrompt:
      "你是总控裁决，纯规则裁决不耗模型：汇总三审结论，全部通过则放行；任一未过则打回提示词设计师改写（只携带本轮反馈，防 prompt 膨胀）；打回超上限时选历史最优候选兜底继续，保证整套交付不卡死。",
    engineNodeType: "supervisor",
    engineRole: null,
  },
]

// ---------------------------------------------------------------------------
// 交付物清单（78 卡 + 6 套件资产 = 84 项）
// ---------------------------------------------------------------------------

export const TAROT_DELIVERABLES: TarotDeliverable[] = [
  {
    kind: "card",
    name: "成品卡牌面",
    description:
      "78 张标准塔罗卡：卡面原图（生图评审阶段产出）在合成阶段叠加边框与牌名/编号排版后成为成品。",
    count: TAROT_CARD_COUNT,
    stageId: "compose",
    perCard: true,
    acceptance: "边框与卡面无错位双框；牌名/编号清晰且不遮主体；画面与牌义对得上。",
  },
  {
    kind: "card_border",
    name: "卡牌边框",
    description:
      "独立生成的边框装饰图：四边纹样对称延续、中心为干净预留区，合成阶段统一叠加到每一张卡。",
    count: 1,
    stageId: "art",
    perCard: false,
    acceptance: "中心预留区无装饰残留；四边纹样连续对称；无文字与编号。",
  },
  {
    kind: "back",
    name: "牌背",
    description: "独立生成的牌背图案：180° 旋转对称，倒过来看不穿帮，全套共用一张。",
    count: 1,
    stageId: "art",
    perCard: false,
    acceptance: "旋转 180° 后视觉等价；无方向性光源与文字；四边有裁切安全区。",
  },
  {
    kind: "box_front",
    name: "牌盒正面",
    description: "牌盒正面主视觉：呈现整套牌的氛围，预留标题排版区（标题由合成阶段叠加）。",
    count: 1,
    stageId: "art",
    perCard: false,
    acceptance: "标题排版区干净可排字；画面风格与卡面成套；竖版构图无变形。",
  },
  {
    kind: "box_back",
    name: "牌盒背面",
    description: "牌盒背面：卡牌氛围场景或纹样组合，下缘预留说明/条码排版区。",
    count: 1,
    stageId: "art",
    perCard: false,
    acceptance: "下缘排版区干净；无可读文字残留；与正面风格统一。",
  },
  {
    kind: "box_side",
    name: "牌盒侧面",
    description: "牌盒侧面（书脊位）：窄长竖构图，装饰纹样可循环延伸，中央预留标题排版区。",
    count: 1,
    stageId: "art",
    perCard: false,
    acceptance: "窄长比例不变形；纹样延伸自然；中央排版区干净。",
  },
  {
    kind: "box_top",
    name: "牌盒顶面",
    description: "牌盒顶面：近方形俯视构图，中心对称装饰，与盒面纹样同源。",
    count: 1,
    stageId: "art",
    perCard: false,
    acceptance: "近方形构图无拉伸；纹样与盒面呼应；无文字。",
  },
]

// ---------------------------------------------------------------------------
// 澄清清单（需求澄清阶段逐条确认）
// ---------------------------------------------------------------------------

export const TAROT_CLARIFICATION: ClarificationSection[] = [
  {
    id: "theme",
    title: "主题与世界观",
    questions: [
      {
        id: "world-view",
        question: "整套牌的世界观与题材方向是什么？",
        why: "决定 78 张卡的意象体系与场景元素，是风格规范书的第一输入。",
        required: true,
        options: ["经典韦特体系", "埃及神话", "凯尔特幻想", "东方水墨", "赛博朋克", "自定义（请描述）"],
        fallback: "经典韦特体系的意象原型，仅做风格化重塑",
      },
      {
        id: "figure-ratio",
        question: "画面以人物为主，还是以场景/器物象征为主？",
        why: "决定构图惯例与人物设定的成套一致性（人物长相/服饰需跨卡统一）。",
        required: true,
        options: ["以人物为主", "人物与场景并重", "以象征器物与场景为主"],
        fallback: "人物与场景并重",
      },
    ],
  },
  {
    id: "style",
    title: "艺术风格",
    questions: [
      {
        id: "medium",
        question: "首选艺术媒介与笔触？",
        why: "决定生图提示词的媒介词与质感描述；成套一致性高度依赖媒介统一。",
        required: true,
        options: ["水彩", "厚涂油画", "铜版画/线描", "扁平数字插画", "复古海报", "自定义（请描述）"],
        fallback: "数字插画，质感细腻、细节密度高",
      },
      {
        id: "palette",
        question: "主色调与辅助色偏好？",
        why: "主色调写进风格规范书，并作为一致性审核的比对基准。",
        required: true,
        options: ["深蓝+金色星象", "酒红+暗金神秘", "黑白+单色点缀", "大地色自然系", "自定义（请描述）"],
        fallback: "深蓝+金色星象",
      },
      {
        id: "lighting",
        question: "明暗氛围取向？",
        why: "影响全部画面的光影描述与情绪基调。",
        required: false,
        options: ["高饱和明快", "明暗对比强烈的戏剧光", "柔和弥散光", "暗黑低明度"],
        fallback: "明暗对比强烈的戏剧光",
      },
    ],
  },
  {
    id: "frame",
    title: "边框与版面",
    questions: [
      {
        id: "border-style",
        question: "卡牌边框的装饰风格？",
        why: "边框由合成阶段统一叠加，需先定稿才能约束卡面构图安全区。",
        required: true,
        options: ["几何对称纹样", "藤蔓花卉", "星空符文", "哥特建筑线框", "纯色细框"],
        fallback: "几何对称纹样",
      },
      {
        id: "typography",
        question: "牌名/编号的排版语言？（只决定合成阶段的文字叠加，不影响生图）",
        why: "文字一律由排版叠加而非生图，此项决定合成阶段的字体与内容。",
        required: true,
        options: ["中文", "英文", "中英双语", "仅编号不排牌名"],
        fallback: "中英双语",
      },
    ],
  },
  {
    id: "packaging",
    title: "牌背与牌盒",
    questions: [
      {
        id: "card-back",
        question: "牌背设计方向？（硬约束：180° 旋转对称）",
        why: "牌背是独立交付资产，旋转对称必须写进提示词显式约束。",
        required: true,
        options: ["中心对称曼陀罗", "星空罗盘", "纹章图案", "与正面同世界观的对称场景"],
        fallback: "中心对称曼陀罗",
      },
      {
        id: "box-form",
        question: "牌盒形态与用途？",
        why: "决定四视图（正面/背面/侧面/顶面）的比例与拼装关系。",
        required: true,
        options: ["天地盖收藏礼盒", "书本式翻盖盒", "抽屉式纸盒", "便携铁盒"],
        fallback: "天地盖收藏礼盒",
      },
    ],
  },
  {
    id: "audience",
    title: "受众与禁忌",
    questions: [
      {
        id: "audience",
        question: "目标受众与使用场景？",
        why: "影响审美及格线与成品精细度取舍。",
        required: false,
        options: ["个人收藏", "出版销售", "礼品定制"],
        fallback: "个人收藏",
      },
      {
        id: "taboo",
        question: "有无必须回避的元素（文化禁忌/版权符号/宗教敏感）？",
        why: "写入风格规范书的负面清单，审核阶段据此加严。",
        required: false,
        options: ["无", "回避宗教符号", "回避真实品牌与文字标识", "自定义（请描述）"],
        fallback: "回避真实品牌与文字标识",
      },
    ],
  },
]

// ---------------------------------------------------------------------------
// 卡面提示词守则（负面禁令；边框/文字/编号/尺寸一律由合成阶段统一叠加）
// ---------------------------------------------------------------------------

export const TAROT_GUARDRAILS: PromptGuardrail[] = [
  {
    id: "no-border",
    rule: "卡面画面内禁止绘制任何边框、装饰框、内描边或角花——边框由合成阶段统一叠加。",
    reason: "生图自带的框与后期边框必然错位形成双框，且会挤占构图安全区。",
    negativePrompt: "border, decorative frame, ornate frame, inner border, corner ornaments",
  },
  {
    id: "no-text",
    rule: "画面内禁止出现任何文字、字母、词语、标语或伪文字（乱码字形）。牌名由排版阶段叠加。",
    reason: "生成模型输出的文字必然乱码，且牌名需要印刷级排版。",
    negativePrompt: "text, letters, words, caption, calligraphy, typography, gibberish glyphs",
  },
  {
    id: "no-numerals",
    rule: "画面内禁止出现罗马数字、阿拉伯数字、序号、页码等任何编号标记。",
    reason: "编号（如 0、XXI、权杖王牌）由排版阶段按卡牌清单统一叠加，画面内编号会与清单不一致。",
    negativePrompt: "roman numerals, numbers, digits, page number, serial number",
  },
  {
    id: "no-dimensions",
    rule: "画面内禁止出现尺寸标注、比例尺、参考线、裁切标记、色卡等制图元素。",
    reason: "这些是设计稿元素而非卡面插画内容，混入画面会破坏成品的插画完整性。",
    negativePrompt: "dimension lines, measurement marks, ruler, crop marks, registration marks, color swatch",
  },
  {
    id: "no-watermark",
    rule: "禁止水印、艺术家签名、logo、二维码。",
    reason: "印刷品不允许第三方标识；署名由版权页统一处理。",
    negativePrompt: "watermark, signature, logo, QR code, stamp",
  },
  {
    id: "full-bleed",
    rule: "卡面必须满幅出血构图：主体完整居中、重心稳定，四边各预留约 8% 安全边距给边框与裁切，关键元素不得贴边。",
    reason: "边框叠加与裁切会吃掉边缘区域，贴边主体会被切坏。",
    negativePrompt: "off-center composition, cropped subject, elements touching edges",
  },
]

/** 卡面生图统一负面提示词（各守则片段直接拼接；套件资产另有专属负面词，不在此列） */
export const TAROT_CARD_ART_NEGATIVE_PROMPT = TAROT_GUARDRAILS.map((g) => g.negativePrompt).join(", ")

// ---------------------------------------------------------------------------
// 套件资产提示词规则（边框/牌背/牌盒四视图；{style} = 风格规范书要点占位）
// ---------------------------------------------------------------------------

export const TAROT_ASSET_RULES: TarotAssetRule[] = [
  {
    deliverableKind: "card_border",
    rules: [
      "独立生成「边框装饰图」：四边装饰纹样对称延续、四角呼应收边。",
      "中心为大面积干净预留区（构图上留白），供卡面画面透出，预留区内不得出现任何装饰元素。",
      "风格、色调严格遵循风格规范书，与卡面成套。",
    ],
    promptTemplate:
      "卡牌边框装饰图，{style}。四边对称延续的装饰纹样，四角呼应收边，中心为大面积干净预留区。纯平面装饰图案，分布均匀，印刷级细节。",
    negativePrompt: "center illustration, center ornament, text, letters, numbers, watermark, signature",
  },
  {
    deliverableKind: "back",
    rules: [
      "必须 180° 旋转对称（中心对称构图）：无方向性光源、无文字方向、无上下之分，倒过来看不穿帮。",
      "主体图案居中，四边留出裁切安全区。",
      "不出现任何文字与编号。",
    ],
    promptTemplate:
      "塔罗牌牌背图案，{style}。中心对称曼陀罗式构图，180° 旋转对称，四边均匀收边，装饰细节丰富，印刷级质感。",
    negativePrompt: "asymmetric composition, directional lighting, text, letters, numbers, watermark, signature",
  },
  {
    deliverableKind: "box_front",
    rules: [
      "牌盒正面：上方或下方预留大面积干净的标题排版区，画面本身不含文字（标题由合成阶段叠加）。",
      "呈现整套牌的核心意象氛围，与卡面风格一致。",
      "竖版牌盒比例，不变形。",
    ],
    promptTemplate:
      "塔罗牌包装盒正面主视觉，{style}。竖版构图，上方预留干净的标题排版区，画面呈现整套牌的核心意象氛围，印刷级质感。",
    negativePrompt: "text, letters, numbers, logo, watermark, signature",
  },
  {
    deliverableKind: "box_back",
    rules: [
      "牌盒背面：展示卡牌氛围场景或纹样组合，可安排数张卡牌的意象剪影（不含可读文字）。",
      "下缘预留说明/条码排版区（保持干净）。",
    ],
    promptTemplate:
      "塔罗牌包装盒背面，{style}。氛围场景与纹样组合，下缘预留干净的说明排版区，竖版构图，印刷级质感。",
    negativePrompt: "readable text, letters, numbers, logo, watermark",
  },
  {
    deliverableKind: "box_side",
    rules: [
      "牌盒侧面（书脊位）：窄长竖构图，装饰纹样可水平循环延伸。",
      "中央预留书脊式标题排版区，画面不含文字。",
    ],
    promptTemplate:
      "塔罗牌包装盒侧面，{style}。窄长竖构图，循环延伸的装饰纹样，中央留干净的标题排版区，印刷级质感。",
    negativePrompt: "text, letters, numbers, watermark, stretched proportions",
  },
  {
    deliverableKind: "box_top",
    rules: [
      "牌盒顶面：近方形俯视构图，中心对称装饰。",
      "纹样与盒正面同源呼应，成套统一。",
    ],
    promptTemplate:
      "塔罗牌包装盒顶面，{style}。近方形俯视构图，中心对称装饰纹样，与盒面纹样同源，印刷级质感。",
    negativePrompt: "asymmetric composition, text, letters, numbers, watermark",
  },
]

// ---------------------------------------------------------------------------
// 78 张卡牌骨架（包装自 pipelines.tarotSkeleton，顺序与牌名单一事实来源）
// ---------------------------------------------------------------------------

const CARDS_PER_SUIT = TAROT_MINOR_COUNT / TAROT_SUIT_ORDER.length // 14

function minorSuit(minorOffset: number): TarotSuit {
  const suit = TAROT_SUIT_ORDER[Math.floor(minorOffset / CARDS_PER_SUIT)]
  return typeof suit === "string" ? suit : TAROT_SUIT_ORDER[0]
}

export const TAROT_CARDS: TarotCardSkeleton[] = tarotSkeleton().map((card) => {
  const minorOffset = card.index - TAROT_MAJOR_COUNT
  if (minorOffset < 0) {
    return { index: card.index, name: card.name, hint: card.hint, arcana: "major", suit: null, rank: null }
  }
  return {
    index: card.index,
    name: card.name,
    hint: card.hint,
    arcana: "minor",
    suit: minorSuit(minorOffset),
    rank: (minorOffset % CARDS_PER_SUIT) + 1,
  }
})

// 骨架完整性守卫：上游 tarotSkeleton() 的张数/顺序若被改动，导入时立即报错
if (TAROT_CARDS.length !== TAROT_CARD_COUNT) {
  throw new Error(`塔罗骨架张数异常：期望 ${TAROT_CARD_COUNT} 张，实际 ${TAROT_CARDS.length} 张`)
}

// ---------------------------------------------------------------------------
// 模板组装
// ---------------------------------------------------------------------------

export const TAROT_TEMPLATE: TarotTemplate = {
  meta: TAROT_META,
  stages: TAROT_STAGES,
  roles: TAROT_ROLES,
  deliverables: TAROT_DELIVERABLES,
  clarification: TAROT_CLARIFICATION,
  guardrails: TAROT_GUARDRAILS,
  assetRules: TAROT_ASSET_RULES,
  cards: TAROT_CARDS,
}
