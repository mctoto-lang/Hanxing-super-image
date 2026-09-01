/**
 * 商品主图提示词模板内置默认值
 *
 * 与 product_prompt_template 表的 scene 一一对应：表缺行/停用时回退到这里，
 * seed 脚本亦从此处写入初始数据（超管改表即可覆盖，无需发版）。
 *
 * V2.7 全模板化：服务端不再拼接任何固定文案，各场景可用变量见
 * prompt-vars.ts 注册表（管理端表单变量芯片同源）。默认模板只引用
 * 必要变量，其余变量管理员可自行加入模板；未引用即不注入（严格模式）。
 * 用户自由文本（补充说明/商品信息）原文透传在 user 消息中，不带服务端标签。
 */

export const PROMPT_SCENE_LABELS: Record<string, string> = {
  "suite.ai_write": "商品套图 · AI 帮写",
  "detail.ai_write": "A+详情页 · AI 帮写",
  "suite.smart_match": "商品套图 · 智能匹配规划",
  "suite.card_prompt": "商品套图 · 卡片画面提示词生成",
  "replicate.level_style": "爆款复刻 · 参考风格",
  "replicate.level_strict": "爆款复刻 · 高度复刻",
}

export const PROMPT_SCENE_GROUP_LABELS: Record<string, string> = {
  suite: "商品套图",
  detail: "A+详情页",
  replicate: "爆款复刻",
}

/** AI 帮写输出的编号格式说明（客户端展示与服务端解析的契约） */
const BRIEF_FORMAT_RULES = [
  `必须严格按以下编号格式输出（编号与标题原样保留，内容写在冒号后）：`,
  `1.商品名称：简洁准确，符合品类命名习惯`,
  `2.核心卖点：4-6 条，每条一行并以 - 开头，不超过 12 个词，具体、可验证、突出差异化`,
  `3.适用人群：一句话`,
  `4.使用场景：一句话描述典型使用情境`,
  `5.规格参数：2-4 条，每条一行并以 - 开头；无明确参数时写"无"`,
  `6.画面建议：一句话（材质/光感/构图）`,
  `只输出 JSON，格式：{"brief":"上述编号格式的完整文本"}`,
].join("\n")

export const DEFAULT_PROMPT_TEMPLATES: Record<string, string> = {
  "suite.ai_write": [
    `你是跨境电商资深商品文案策划。分析用户提供的商品图片（如有）与补充说明，为 {{platformLabel}} 平台撰写商品信息。`,
    `商品信息一律用简体中文撰写；遵循该平台的 Listing 文案规范。`,
    BRIEF_FORMAT_RULES,
  ].join("\n"),
  "detail.ai_write": [
    `你是跨境电商资深商品文案策划。分析用户提供的商品图片（如有）与补充说明，为 {{platformLabel}} 平台的 A+ 详情页撰写商品信息。`,
    `商品信息一律用简体中文撰写；内容面向 A+ 内容模块文案，条目可更侧重参数与场景说明。`,
    BRIEF_FORMAT_RULES,
  ].join("\n"),
  "suite.smart_match": [
    `你是电商视觉套图策划专家。基于商品图片、商品信息（卖点与要求，见用户消息）和下方模块池，规划一组高转化率的电商 Listing 套图。要求：`,
    `1. 分析商品外观：材质、颜色、结构、可特写细节，写入 productAnalysis`,
    `2. 结构配比（从模块池中选择，selected: true/false）：`,
    `   - 白底图/首屏主图类模块必选，是平台主图位核心`,
    `   - 卖点类与场景类优先保障：帮助买家快速理解价值与使用情境`,
    `   - 细节/对比/规格类：结合商品特征选最值得展示的点，宁缺毋滥`,
    `3. 总量约束：整组套图默认 7 张、最多 9 张；依据商品信息（卖点与要求）`,
    `   决定每个方向的具体张数分配（count，1 到该模块 maxCount）`,
    `4. 为每个选中模块给出定制指导：`,
    `   - angle: 机位/角度建议（简体中文）`,
    `   - focus: 画面主体和景别（简体中文）`,
    `   - copyHint: 图上短文案，不超过 6 个词（用{{outputLanguage}}）`,
    `   - target: 特写对象（简体中文，仅细节类需要）`,
    `   - count: 建议张数（1 到该模块 maxCount）`,
    `5. 未选中的模块 selected: false 即可`,
    `可用模块池：`,
    `{{directionPool}}`,
    `只输出 JSON，格式：`,
    `{"productAnalysis":{"category":"...","materials":[],"colors":[],"designFeatures":[]},`,
    ` "slots":[{"key":"...","selected":true,"angle":"...","focus":"...","copyHint":"...","count":1}]}`,
  ].join("\n"),
  "suite.card_prompt": [
    `你是资深电商摄影指导与电商视觉设计师，擅长为跨境电商 Listing 打造高点击率、富有设计感的商品图。基于商品信息（卖点与要求）、参考图与给定的图片方向，为每个方向撰写一条可直接用于生图模型的画面提示词。要求：`,
    `1. 语言：画面提示词正文一律用简体中文撰写；仅图内出现的文字（标题、卖点短语、标签等）使用{{outputLanguage}}`,
    `2. 平台规范（重要——提示词提交时原样透传，服务端不会追加任何规范，必须在这一步写进卡片）：按 {{platformLabel}} 平台把适用规范要点直接写入提示词对应位置：`,
    `   - 亚马逊 Amazon：白底主图类须纯白背景（#FFFFFF）、商品占比 85% 以上、无边框/logo/水印/道具/促销文字；其余图遵循 A+ 内容规范：版面干净、信息清晰、装饰克制`,
    `   - Temu：背景干净明快、主体突出、色彩鲜亮，突出性价比与促销氛围，无水印与杂乱贴纸`,
    `   - SHEIN：潮流年轻化视觉、时尚感构图、配色紧跟流行趋势，画面轻盈通透`,
    `   - TikTok Shop：社交原生风格、动感强、对比鲜明、第一眼抓眼球，无水印边框`,
    `   若平台不在上述清单，按该平台通行的电商图片规范执行`,
    `3. 白底主图类方向（白底图/主图）例外：保持纯净构图——纯白背景、无文字、无图形装饰、无道具，仅用机位与布光塑造商品立体感`,
    `4. 其余方向的每条提示词必须同时覆盖「版式设计」与「摄影质感」，并写足商品信息：`,
    `   - 版式结构：明确画面分区与布局（如上下分层：主视觉占上 2/3+底部信息栏；左右分栏；多宫格；横向步骤流），说明各区域的内容与占比`,
    `   - 设计元素：具体列出图形元素及位置——图标徽章、编号圆标、标注引线、数据大字（把卖点中的量化信息转化为 +20%、360° 式大数字）、色块/渐变背景、VS 圆标、箭头引导等`,
    `   - 文字内容：给出主标题短语与副标题文案；卖点类方向列 3~5 条要点短句，要点须来自商品信息（卖点与要求），不得虚构参数`,
    `   - 色彩系统：从参考图商品提取主色，搭配一个对比强调色用于标题与图形元素，背景为浅色渐变或纯净底色`,
    `   - 摄影质感：商品外观、材质、颜色须与参考图严格一致；明确景别与机位、布光方式、材质表现`,
    `5. 图内文字短语精炼、层级分明，遵循 {{platformLabel}} 平台的视觉偏好与图片规范`,
    `6. 同一方向的多张卡片，须在机位、构图或版式上明显区分`,
    `7. 禁止堆砌"高清、精美、专业"等空洞形容词；每条 250~350 字，信息量宁多勿少`,
    `商品信息（含卖点与要求）见用户消息原文。本次需出卡的方向共 {{cardCount}} 个，按序号列出如下：`,
    `{{cards}}`,
    `只输出 JSON，index 与上方方向清单的序号一一对应，逐条返回不要遗漏：`,
    `{"prompts":[{"index":1,"prompt":"..."},{"index":2,"prompt":"..."}]}`,
  ].join("\n"),
  "replicate.level_style":
    "Match the visual style, mood and color palette of the style reference image, while composing an original layout featuring the provided product. The LAST reference image is the style/layout reference; the other reference images are the product to feature. {{platformGeneralSegment}} {{languageDirective}} {{additionalPrompt}}",
  "replicate.level_strict":
    "Closely replicate the composition, layout, text placement and overall design of the style reference image, substituting the product with the provided one. The LAST reference image is the style/layout reference; the other reference images are the product to feature. {{platformGeneralSegment}} {{languageDirective}} {{additionalPrompt}}",
}

/** 各场景可用变量说明（超管表单帮助文案 / 表 note 默认值；完整注册表见 prompt-vars.ts） */
export const PROMPT_SCENE_NOTES: Record<string, string> = {
  "suite.ai_write":
    "变量：{{platformKey}} {{platformLabel}} {{outputLanguage}} {{userNotes}}。商品信息固定简体中文输出（默认不引用 {{outputLanguage}}，需要跟随语言时可自行加入）；补充说明同时原文透传在 user 消息。输出需为 JSON：{\"brief\":\"编号文本块\"}",
  "detail.ai_write":
    "变量：{{platformKey}} {{platformLabel}} {{outputLanguage}} {{userNotes}}。商品信息固定简体中文输出（默认不引用 {{outputLanguage}}，需要跟随语言时可自行加入）；补充说明同时原文透传在 user 消息。输出需为 JSON：{\"brief\":\"编号文本块\"}",
  "suite.smart_match":
    "变量：{{platformKey}} {{platformLabel}} {{outputLanguage}} {{productName}} {{directionPool}}（模块池多行清单，未引用即不注入）。商品信息原文透传在 user 消息。总量默认 7 张、最多 9 张（服务端规范化保底）。输出需为 JSON（slots 结构）",
  "suite.card_prompt":
    "变量：{{platformKey}} {{platformLabel}} {{outputLanguage}} {{cardCount}} {{cards}}（编号方向清单，未引用即不注入）。画面提示词正文固定输出简体中文（便于用户编辑），仅图内文字按语言设置；每条 250~350 字，须同时覆盖版式设计与摄影质感并写足商品信息（白底主图类方向除外，保持纯净构图）。提示词经用户确认后原样透传生图（服务端不追加任何内容），平台规范要点必须由本模板要求 AI 写进每条卡片。商品信息原文透传在 user 消息。输出需为 JSON：{\"prompts\":[{\"index\":1,\"prompt\":\"画面提示词\"}]}",
  "replicate.level_style":
    "变量：{{platformKey}} {{platformLabel}} {{outputLanguage}} {{platformGeneralSegment}} {{platformHeroSegment}} {{platformSegment}} {{languageDirective}} {{additionalPrompt}}。本模板即最终生图 prompt（参考图语义句已内置于默认正文）；未引用的变量不注入，用户补充要求仅在被 {{additionalPrompt}} 引用时生效。",
  "replicate.level_strict":
    "变量：{{platformKey}} {{platformLabel}} {{outputLanguage}} {{platformGeneralSegment}} {{platformHeroSegment}} {{platformSegment}} {{languageDirective}} {{additionalPrompt}}。本模板即最终生图 prompt（参考图语义句已内置于默认正文）；未引用的变量不注入，用户补充要求仅在被 {{additionalPrompt}} 引用时生效。",
}
