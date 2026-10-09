/**
 * 塔罗牌模板（卡牌模板注册表 · 首条产品线）
 *
 * 面向「成套卡牌设计」场景的完整创作规格：固定元数据 + 四阶段流程 +
 * 八角色编制 + 交付物清单（78 卡 + 边框/牌背/牌盒四视图）+ 澄清清单 +
 * 提示词守则 + 花色数量硬规则 + 78 张卡牌骨架。
 *
 * 四阶段：需求澄清（内容/风格分轨）→ 画面提示词（方向选择 + 78 张画面
 * 内容，固定风格提示词由系统统一拼接，用户可编辑）→ 生图与评审（不通过
 * 按评审意见重写画面内容）→ 融合与交付。
 *
 * 结构契约：
 * - 卡牌骨架包装自 ../pipelines 的 tarotSkeleton()，顺序与牌名严格一致，
 *   本文件不重复定义牌名（单一事实来源）；
 * - 新流程卡面提示词 = 画面内容（120-200 字，约 160 字，LLM 撰写，严禁任何
 *   风格词——媒介/画风流派/质感/整体色调色系）+ 固定风格提示词
 *   （整套逐字统一，约 100 字）+ 无边框句，后两者由系统确定性拼接（不经 LLM 抄写，
 *   杜绝整套风格漂移；整体提示词控制在 260 字左右）；内容不带任何负向提示词；
 *   TAROT_GUARDRAILS 仅供模板数据（guardrails 字段）与套件资产生成路径继续引用；
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

/** 模板固定四阶段数（澄清 → 画面提示词 → 生图评审 → 融合与交付） */
export const TAROT_STAGE_COUNT = 4

/** 小阿卡纳花色（顺序与 pipelines.tarotSkeleton 的出牌顺序一致） */
export const TAROT_SUIT_ORDER = ["权杖", "圣杯", "宝剑", "星币"] as const
export type TarotSuit = (typeof TAROT_SUIT_ORDER)[number]

export type TarotArcana = "major" | "minor"

/**
 * 四阶段 id（存量 run 的 world/prompt/final 由 normalizeTemplateStage
 * 映射到 draft 后使用；final_refiner 角色仅为存量终稿流程保留）
 */
export type TarotStageId = "clarify" | "draft" | "art" | "compose"

/** 八角色编制（模板层职责命名；引擎映射见 TarotRole.engineRole/engineNodeType） */
export type TarotRoleId =
  | "creative_director"
  | "style_director"
  | "prompt_designer"
  | "final_refiner"
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
    "标准 78 张塔罗（22 大阿卡纳 + 56 小阿卡纳）+ 边框/牌背/牌盒套件资产，四阶段流水线产出可直接印刷的全套设计稿（共 84 项交付物）。",
  cardCount: TAROT_CARD_COUNT,
  // 小样代表卡：愚者 / 魔术师 / 世界（大阿卡纳）+ 权杖王牌 / 权杖十 / 圣杯三（小阿卡纳数字牌）
  sampleIndexes: sampleIndexes("tarot", TAROT_CARD_COUNT, 6),
}

// ---------------------------------------------------------------------------
// 四阶段流程
// ---------------------------------------------------------------------------

export const TAROT_STAGES: TarotStage[] = [
  {
    id: "clarify",
    order: 1,
    name: "需求澄清",
    goal: "把内容（主题/题材/画面主体）与风格（媒介/色调/氛围）分轨收敛为可直接创作的明确决策。",
    roleIds: ["creative_director"],
    inputs: ["内容描述 + 风格描述（发起弹窗分轨输入）", "风格参考图（≤4 张，仅提取风格样式）"],
    outputs: ["澄清结论（内容/风格两组追问）", "设计简报（内容简报 + 风格简报）", "风格规范书（自动定稿）"],
    exitCriteria: ["内容与风格要素齐备或采用默认取向", "风格结论与参考图风格不冲突"],
  },
  {
    id: "draft",
    order: 2,
    name: "画面提示词",
    goal: "先定风格方向（3 选 1，各带示例图），再逐张撰写画面内容——固定风格提示词由系统统一拼接，用户可编辑。",
    roleIds: ["style_director", "prompt_designer"],
    inputs: ["设计简报（内容/风格两节）", "风格参考图", "78 张卡牌骨架（含花色数量规则）"],
    outputs: ["风格规范书 + 固定风格提示词 + 每方向 1 张示例图", "78 条画面提示词（画面内容 120-200 字 + 系统拼接的固定风格提示词，整体约 260 字）"],
    exitCriteria: ["风格方向已选定", "78 张提示词齐备且每张 ≥60 字（画面内容建议 120-200 字，约 160 字）", "Ace-10 明确写出花色物品数量"],
  },
  {
    id: "art",
    order: 3,
    name: "生图与评审",
    goal: "按提示词产出全部画面，并通过三审裁决循环；不通过按评审意见重写提示词再生成。",
    roleIds: ["prompt_designer", "artist", "review_panel", "supervisor"],
    inputs: ["78 条画面提示词", "风格参考图", "审核及格线（含花色数量校验）"],
    outputs: ["78 张过审卡面图", "6 个过审套件资产图"],
    exitCriteria: ["内容对齐/审美/成套一致性三审通过（Ace-10 数量不符必打回）", "打回耗尽时按历史最优兜底放行"],
  },
  {
    id: "compose",
    order: 4,
    name: "融合与交付",
    goal: "选择边框参考图批量 AI 融合 78 张卡面，装配为可直接印刷的全套交付物。",
    roleIds: ["compositor", "supervisor"],
    inputs: ["过审卡面图", "边框参考图（已有资产或上传）", "牌背/牌盒资产（平台默认规格）"],
    outputs: ["78 张成品卡（AI 融合边框）", "牌盒四视图成品稿", "交付清单（共 84 项）"],
    exitCriteria: ["交付清单逐项齐全且与交付物定义一致", "文字与装饰不遮盖卡面主体"],
  },
]

// 阶段数守卫：模板固定五段，误增删在这里第一时间炸出来
if (TAROT_STAGES.length !== TAROT_STAGE_COUNT) {
  throw new Error(`塔罗模板阶段数异常：期望 ${TAROT_STAGE_COUNT} 段，实际 ${TAROT_STAGES.length} 段`)
}

// ---------------------------------------------------------------------------
// 八角色编制
// ---------------------------------------------------------------------------

export const TAROT_ROLES: TarotRole[] = [
  {
    id: "creative_director",
    name: "创意总监",
    group: "planning",
    duty: "主持需求澄清：内容/风格两轨分头追问，对最终风格负总责",
    systemPrompt:
      "你是资深卡牌创意总监，主持需求澄清。追问分两轨：①内容轨（主题立意、世界观、画面主体与题材元素）；②风格轨（艺术媒介、画风、色调氛围）。用户已分别提供内容描述与风格描述时，只就对应轨道中仍模糊的部分追问；初始描述或历史回答中已明确的信息直接采纳，不追问、不做确认式追问；严禁追问任何生产与印制细节（牌盒尺寸、卡片尺寸、纸张印刷、数量排版等）——这些由平台默认规格承担，与画面创作无关。参考图仅用于提取艺术风格样式（媒介、笔触、色调、氛围），不得据此追问或推断画面内容。用户给出参考图时先仔细读图再提问，风格轨结论必须与参考图强对齐。每轮最多 3 个问题（先内容后风格），每个问题标注所属轨道；每个问题的选项先在内部结合用户主题构思约 10 个候选，再挑出最合适的 3 个作为推荐选项（贴合主题、每次不重样，不照抄清单默认项）。内容与风格两轨要素齐备时立即判定信息足够。输出《澄清结论》与《设计简报》（分【内容简报】【风格简报】两节），每条要点具体到可直接写进风格规范书。",
    engineNodeType: "agent",
    engineRole: "style",
  },
  {
    id: "style_director",
    name: "风格策划",
    group: "planning",
    duty: "依据澄清结论产出 3 个候选《风格规范书》方向供用户选择（固定风格提示词 + 示例图 + 花色映射）",
    systemPrompt:
      "你是卡牌风格策划师。依据《澄清结论》的【风格简报】（与风格参考图，若有——参考图仅用于提取艺术风格样式，不参考其画面内容）构思并产出 3 份彼此差异明显的候选《风格规范书》，供用户选择；【内容简报】仅作题材呼应参考，不决定风格。每个候选包含：固定风格提示词（80-120 字，约 100 字，选定后由系统逐字拼接到整套 78 张每张画面提示词的末尾，用于固定画面风格——必须一次写全，格式范例：「受 Rebecca Campbell 启发的现代空灵神谕卡艺术，灰蓝色磨砂薄雾，柔和哑光磨砂质感，神圣临在感，细腻漂浮的星点闪尘与光尘，梦境般的空灵薄纱，极简构图与留白，柔和大地色系配淡金点缀，fine art 神谕插画，柔和漫射光，朦胧大气薄雾」；要素：艺术家/流派灵感、媒介与质感、氛围关键词、构图与留白、色系与点缀、画种（可用 fine art 等英文画种词）、光线特征）；艺术媒介与笔触说明；主辅色直观描述；构图与光影惯例；四花色元素映射（权杖-火/圣杯-水/宝剑-风/星币-土）。风格必须与用户参考图（若有）强对齐，且足以让 78 张画面呈现出同一系列作品的统一感。每个方向会以示例卡场景生成 1 张示例图供用户预览。",
    engineNodeType: "agent",
    engineRole: "structure",
  },
  {
    id: "prompt_designer",
    name: "提示词设计师",
    group: "planning",
    duty: "逐张撰写画面内容（约 160 字，只写内容不写风格；固定风格提示词由系统拼接，用户可编辑）",
    systemPrompt:
      "你是卡牌画面提示词设计师，逐张为每张牌撰写画面内容（120-200 字中文单段，约 160 字——系统会再拼接约 100 字的固定风格提示词，整体控制在 260 字左右）。只写画面内容——固定风格提示词（整套逐字统一，用于固定画面风格）与无边框结尾句由系统自动拼接到每张提示词末尾，请勿写入任何风格描述或结尾句。画面内容需覆盖：唯一主体（人物/动物/物品，即牌义的核心象征）及其外观细节、动作与神态、道具、环境场景与氛围（含场景内的具体光影叙事，如光从何处来、照亮什么）。硬性规则：①权杖/圣杯/宝剑/星币的 Ace 至十（王牌至十），画面必须包含恰好对应数量（1-10）的花色物品，且把数量写进描述（如「五只圣杯」「三根权杖」），多件物品自然成组、每件有支撑或落点，不描述具体的摆放方式与位置关系（摆放构图交给生图模型自由发挥）；②侍从/骑士/王后/国王及大阿卡纳不要求画面呈现牌名或身份文字，只需主体鲜明、贴合牌义；③内容为单段连贯中文，不使用分段标记或序号，保持行文自然不罗列清单；④不写任何负向约束或「不要出现××」类表述；⑤严禁任何风格词——艺术媒介（水彩/油画/版画）、画风流派（赛博朋克/浮世绘/皮克斯风）、画面质感（磨砂/哑光/颗粒感）、整体色调色系（蓝金色调/暖色调/莫兰迪色系）都不属于画面内容，风格由系统拼接的固定风格提示词统一承担，写了会与之冲突、破坏整套 78 张一致性（卡面边框由后期合成统一叠加）。打回重写时：以当前画面内容为基准重写，仅针对评审意见调整，不保留被指出问题的表述。",
    engineNodeType: "agent",
    engineRole: "copywriter",
  },
  {
    id: "final_refiner",
    name: "终稿细化师",
    group: "planning",
    duty: "（存量 run 过渡期）把旧初稿细化为结构化两段终稿；新流程已并入初稿设计师",
    systemPrompt:
      "你是卡牌画面提示词终稿细化师。把每张初稿细化为可直接生图的中文终稿，结构固定为两段：[1] 画面风格：直接使用给定的《风格规范书》画面风格总述，整套逐字一致，不得逐张改写；[2] 画面内容：在初稿基础上细化为主体外观细节、动作姿态、服饰道具、环境背景、光影与色彩对比（150-250 字），主体占画面 60% 以上、近景或特写、竖版构图（与卡面出图比例一致）、视觉冲击力强。硬性规则：①权杖/圣杯/宝剑/星币的 Ace 至十，画面内容必须明确包含恰好对应数量（1-10）的花色物品并写进描述（如「画面中有五只高脚圣杯」）；②其余牌（侍从/骑士/王后/国王及大阿卡纳）不要求画面体现牌名或身份文字；③终稿只含 [1][2] 两段画面描述，除「无边框硬规则」外禁止输出任何其他负向提示词或禁令；④【无边框硬规则】画面四边不得出现任何类似边框的连续内容——包括沿画面边缘连续分布的装饰纹样、线条、色带与留白描边；[2] 画面内容的结尾必须明确写出「画面边缘为干净的满幅构图，无任何边框或边缘装饰」，这是终稿中唯一允许的禁止性表述。打回重细化时：以初稿为基准重新细化生成完整终稿，仅针对评审意见调整，不保留旧终稿中被指出问题的表述。（注：此角色仅为存量 run 的旧终稿流程保留；新流程中首次撰写即终稿。）",
    engineNodeType: "agent",
    engineRole: "copywriter",
  },
  {
    id: "artist",
    name: "画师",
    group: "production",
    duty: "按画面提示词逐张生图（纯文生图，提示词末尾拼接固定风格提示词保证风格统一）",
    systemPrompt:
      "你是卡牌画师，按提示词逐张出图（纯文生图，不传参考图）：严格执行提示词末尾的固定风格提示词所约定的媒介、色调与氛围，准确呈现提示词描述的主体、场景与氛围；满幅出血、主体居中、四边预留安全边距。",
    engineNodeType: "image_gen",
    engineRole: null,
  },
  {
    id: "review_panel",
    name: "评审团",
    group: "qa",
    duty: "内容对齐（含花色数量校验）/ 审美评分 / 成套一致性三审并行，打回必附理由",
    systemPrompt:
      "你们是三审评审团。内容审：画面是否准确呈现终稿提示词的主体、场景与氛围；权杖/圣杯/宝剑/星币的 Ace 至十必须逐一清点画面中花色物品的数量，数量不符直接判内容不通过；其余牌（宫廷牌与大阿卡纳）不因未呈现牌名或身份文字而扣分。审美审：构图/色彩/细节/执行质量按 0-100 打分，宁严勿宽，主体占比过低、视觉冲击弱的图必须扣分；花色物品悬空漂浮、无受力贴附时必须扣分并写明具体位置（摆放方式与位置关系由生图模型自由发挥，不因排列样式扣分）；画面边缘出现类似边框的连续装饰（沿边缘的纹样、线条、色带、留白描边）必须扣分并作为打回理由——卡面边框由后期合成统一叠加，画面内出现边框类内容即废卡。一致性审：与风格规范书（含风格短语）及基准图比对色调、媒介质感、构图惯例是否成套，明显跳出风格的给低分。每次打回必须给出可执行的具体理由（哪一项、差在哪、怎么改），这是提示词重写的唯一依据。",
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
    duty: "三审裁决：放行 / 打回重细化 / 兜底选优，纯规则不耗模型",
    systemPrompt:
      "你是总控裁决，纯规则裁决不耗模型：汇总三审结论，全部通过则放行；任一未过则打回提示词设计师（携带当前提示词与本轮反馈重写，只带当轮反馈防 prompt 膨胀）；打回超上限时选历史最优候选兜底继续，保证整套交付不卡死。",
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
    acceptance: "标题排版区干净可排字；画面风格与卡面成套；构图比例与卡面一致无变形。",
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
    description: "牌盒侧面（书脊位）：装饰纹样可循环延伸，中央预留标题排版区，比例与卡面一致。",
    count: 1,
    stageId: "art",
    perCard: false,
    acceptance: "构图比例与卡面一致不变形；纹样延伸自然；中央排版区干净。",
  },
  {
    kind: "box_top",
    name: "牌盒顶面",
    description: "牌盒顶面：俯视构图，中心对称装饰，与盒面纹样同源，比例与卡面一致。",
    count: 1,
    stageId: "art",
    perCard: false,
    acceptance: "构图无拉伸；纹样与盒面呼应；无文字。",
  },
]

// ---------------------------------------------------------------------------
// 澄清清单（需求澄清阶段逐条确认；只覆盖风格/内容/主题/画面内容，
// 不含牌盒尺寸、卡片尺寸等生产细节——生产规格由平台默认承担）
// ---------------------------------------------------------------------------

export const TAROT_CLARIFICATION: ClarificationSection[] = [
  {
    id: "theme",
    title: "主题与世界观",
    questions: [
      {
        id: "world-view",
        question: "整套牌的主题立意与世界观方向是什么？",
        why: "决定 78 张卡的意象体系与场景元素，是风格规范书的第一输入。",
        required: true,
        options: [
          "经典韦特体系",
          "埃及神话",
          "凯尔特幻想",
          "东方水墨",
          "赛博朋克",
          "北欧符文史诗",
          "蒸汽朋克机械",
          "深海神秘学",
          "敦煌壁画飞天",
          "暗黑童话",
          "自定义（请描述）",
        ],
        fallback: "经典韦特体系的意象原型，仅做风格化重塑",
      },
      {
        id: "figure-ratio",
        question: "画面内容以人物为主，还是以场景/器物象征为主？",
        why: "决定构图惯例与人物设定的成套一致性（人物长相/服饰需跨卡统一）。",
        required: true,
        options: ["以人物为主", "人物与场景并重", "以象征器物与场景为主", "以动物拟人为主"],
        fallback: "人物与场景并重",
      },
      {
        id: "taboo",
        question: "画面内容有无必须回避的元素（文化禁忌/版权符号/宗教敏感）？",
        why: "回避元素写进风格规范书，画面创作与审核据此规避。",
        required: false,
        options: ["无", "回避宗教符号", "回避真实品牌与文字标识", "回避昆虫", "回避血腥肢体", "自定义（请描述）"],
        fallback: "回避真实品牌与文字标识",
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
        why: "决定画面风格总述的媒介词与质感描述；成套一致性高度依赖媒介统一。",
        required: true,
        options: [
          "水彩",
          "厚涂油画",
          "铜版画/线描",
          "扁平数字插画",
          "复古海报",
          "暗黑数字手绘勾线",
          "哥特蚀刻线稿",
          "浮世绘木刻",
          "赛博霓虹光效",
          "蜡笔肌理童趣",
          "3D 黏土渲染",
          "自定义（请描述）",
        ],
        fallback: "数字插画，质感细腻、细节密度高",
      },
      {
        id: "palette",
        question: "主色调与辅助色偏好？",
        why: "主色调写进风格规范书，并作为一致性审核的比对基准。",
        required: true,
        options: [
          "深蓝+金色星象",
          "酒红+暗金神秘",
          "猩红+漆黑暗黑系",
          "黑白+单色点缀",
          "大地色自然系",
          "翡翠绿+古铜",
          "珊瑚橙+奶油白",
          "莫兰迪灰调",
          "紫金幻夜",
          "自定义（请描述）",
        ],
        fallback: "深蓝+金色星象",
      },
      {
        id: "lighting",
        question: "明暗氛围取向？",
        why: "影响全部画面的光影描述与情绪基调。",
        required: false,
        options: ["高饱和明快", "明暗对比强烈的戏剧光", "柔和弥散光", "暗黑低明度", "烛光暖调", "霓虹逆光"],
        fallback: "明暗对比强烈的戏剧光",
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

// ---------------------------------------------------------------------------
// 套件资产提示词规则（边框/牌背/牌盒四视图）
//
// 每条 promptTemplate 是专门撰写的完整内容描述（画面主体/构图布局/纹样
// 体系/材质工艺均自成一体）；{style} 仅注入从风格规范书提炼的「风格要点」
// （见 asset-prompts.extractStyleEssence），不整段搬策划方案文本。
// ---------------------------------------------------------------------------

export const TAROT_ASSET_RULES: TarotAssetRule[] = [
  {
    deliverableKind: "card_border",
    rules: [
      "仅绘制边框带与四角角饰；中心预留区必须完全干净，不得出现任何装饰纹样、笔触或渐变。",
      "四边纹样带宽一致、视觉重量均衡，转角处纹样自然转向衔接、不断裂。",
      "纹样题材与色调严格取自风格要点，与整套卡面成套。",
    ],
    promptTemplate:
      "卡牌边框装饰图（合成阶段叠加在卡面之上的透明边框素材）。画面只由沿四边向内延展的装饰纹样带构成：带宽约占每边宽度的百分之八到十二，纹样沿边带连续流动、节律均匀，在四角以徽记式角花收拢；边框带围合的中心区域为大面积完全干净的预留区，供卡面插画透出。纹样从风格要点（{style}）的意象体系中取材，呈藤蔓式或轨道式连续结构，精致繁密但边界清晰，印刷级细节。",
    negativePrompt: "center illustration, center ornament, center pattern, text, letters, numbers, watermark, signature",
  },
  {
    deliverableKind: "back",
    rules: [
      "严格 180° 旋转对称（中心对称构图）：任何方向倒置都不穿帮，无方向性光源、无上下之分。",
      "主体居中、层次由内向外展开，四边留出裁切安全区。",
      "画面不出现任何文字、字母与数字。",
    ],
    promptTemplate:
      "塔罗牌牌背图案（整副牌共用的一张背面）。以画面中心为轴心向外层层展开的曼陀罗式对称构图：中央一枚凝练整套牌核心意象的徽记式主纹样，向外逐层推开环形装饰带，层与层之间以细密点缀（星点、珠链、小花纹）过渡，至四边均匀收边。整幅图案呈中心对称——旋转一百八十度后与原图完全重合，无方向性光影。题材与色调取自风格要点（{style}），与七十八张卡面同属一套视觉体系，近看有细节、远看有轮廓。",
    negativePrompt: "asymmetric composition, directional lighting, readable text, letters, numbers, watermark, signature",
  },
  {
    deliverableKind: "box_front",
    rules: [
      "上方预留大面积干净标题排版区，画面本身不含任何文字（标题由合成阶段叠加）。",
      "核心意象与卡面风格严格成套，主体完整、重心稳定。",
      "{orientation}构图、不变形（比例与卡面出图一致）。",
    ],
    promptTemplate:
      "塔罗牌包装盒正面主视觉。{orientation}成品盒面：底部以与整套卡面同源的连续装饰纹样做基座收边；中段展开这套牌最具代表性的核心意象场景（从风格要点 {style} 中选取两到三个视觉母题，主次分明、相互呼应）；画面上方约三分之一保持干净、低密度，预留标题排版。呈现可直接印刷的盒面效果，纸纹、烫金等工艺质感与风格要点一致。",
    negativePrompt: "text, letters, numbers, logo, watermark, signature",
  },
  {
    deliverableKind: "box_back",
    rules: [
      "卡牌意象剪影不含可读文字与编号。",
      "下缘预留干净的说明与条码排版区。",
      "{orientation}构图、不变形（比例与卡面出图一致）。",
    ],
    promptTemplate:
      "塔罗牌包装盒背面。安静、低密度的氛围画面：以整套牌的次级意象构成背景场景（与正面主视觉同源但更收敛），画面中散布数张卡牌意象的剪影轮廓，呈有节奏的对角或网格排布；下缘约五分之一保持干净，预留给说明文字与条码排版。题材与色调取自风格要点（{style}），与盒面正面的纹样体系一脉相承。",
    negativePrompt: "readable text, letters, numbers, logo, watermark, stretched proportions",
  },
  {
    deliverableKind: "box_side",
    rules: [
      "{orientation}构图，主纹样沿水平方向可循环延伸（首尾可无缝衔接）。",
      "中央预留干净的书脊标题排版区，画面不含文字。",
      "纹样不拉伸变形。",
    ],
    promptTemplate:
      "塔罗牌包装盒侧面（书脊位）。{orientation}构图的装饰带：一条主纹样沿水平方向贯穿画面全长，节律均匀、首尾可无缝循环衔接；画面中央留一段干净的窄带，供书脊标题排版。纹样题材与盒正面同源（取自风格要点 {style}），密度低于正面，保证远距离可辨识。",
    negativePrompt: "text, letters, numbers, watermark, stretched proportions",
  },
  {
    deliverableKind: "box_top",
    rules: [
      "{orientation}构图、中心对称（比例与卡面出图一致）。",
      "纹样与盒正面同源呼应、成套统一。",
      "画面不含文字。",
    ],
    promptTemplate:
      "塔罗牌包装盒顶面。{orientation}俯视构图：一枚中心对称的徽记式纹样居于画面中心——它是盒正面核心意象的凝练版本，四周以细纹收边、留白充分，从上方拿起盒子时第一眼即有整体感与品质感。纹样体系与盒面同源（取自风格要点 {style}），成套统一。",
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
// 花色数量硬规则（注入初稿/终稿/评审提示词）
// ---------------------------------------------------------------------------

/** 数字牌数量中文（rank 1-10 → 一…十） */
const RANK_COUNT_WORDS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"] as const

/** 花色数量硬规则总述（写进提示词设计师/存量终稿细化师/评审员 system prompt） */
export const SUIT_COUNT_RULE_SUMMARY = [
  "【花色数量硬规则】权杖/圣杯/宝剑/星币的 Ace（王牌）至十：画面必须包含恰好对应数量（1-10）的花色物品，并把数量明确写进画面描述；花色物品只写数量与形态细节，不要描述具体的摆放方式与位置关系（如几行几列、对称阵列、某物在另一物旁/上方等），摆放构图交给生图模型自由发挥；",
  "其余牌（侍从/骑士/王后/国王及大阿卡纳）：不要求画面体现牌名或身份文字，只需主题明确、风格统一、画面美观。",
].join("")

/**
 * 单卡花色数量规则文本：
 * - 小阿卡纳数字牌（rank 1-10）：恰好 N 个花色物品（≥2 件不描述具体摆放位置）
 * - 宫廷牌 / 大阿卡纳：无数量与牌名要求
 */
export function suitCountRuleOf(card: {
  arcana?: TarotArcana
  suit: TarotSuit | null
  rank: number | null
}): string {
  if (card.arcana === "major" || !card.suit || card.rank == null || card.rank < 1 || card.rank > 10) {
    return "不要求画面体现牌名或身份文字，只需主题明确、风格统一、画面美观。"
  }
  const word = RANK_COUNT_WORDS[card.rank - 1]!
  const arrangement =
    card.rank >= 2
      ? "多件物品自然成组出现在画面中、每件有支撑或落点即可；不要描述具体的摆放方式与位置关系（如几行几列、对称阵列、某物在另一物旁/上方等），摆放构图交给生图模型自由发挥。"
      : ""
  return `画面必须包含恰好 ${card.rank} 个（${word}）「${card.suit}」花色物品，数量明确写进描述（量词按物品形态选择，如「${word}根权杖」「${word}只圣杯」）。${arrangement}`
}

/** 按骨架序号取单卡花色数量规则（越界回退通用表述） */
export function suitCountRuleByIndex(index: number): string {
  const card = TAROT_CARDS[index]
  return card ? suitCountRuleOf(card) : "不要求画面体现牌名或身份文字，只需主题明确、风格统一、画面美观。"
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
