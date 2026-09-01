/**
 * 种子：商品主图 V2 主数据（方向池 + 平台尺寸规范）
 *
 * 幂等写入 24 个方向（5 套图精选方向 appliesTo=[suite] + 14 A+详情页模块
 * appliesTo=[detail] + 5 画质项 appliesTo=[refine]）与 Amazon A+ 尺寸规范。
 * 已存在的 key 跳过（不覆盖超管后续修改）。
 *
 * V2.2（中文高质量版）：
 * - 套图方向 promptTemplate 全部中文化；hero_visual/core_selling/usage_scene
 *   改名为 白底图/卖点图/场景图（存量行按旧默认值守护式升级）
 * - 除 3 个核心方向外，其余 11 个套图方向设 isHidden=true（自定义配置前端
 *   只展示 白底图/场景图/卖点图/其他；智能匹配与「其他」AI 候选池不受影响）
 * - smart_match / card_prompt 对话模板升级（画面提示词正文输出简体中文）
 *
 * V2.3（规范段变量化）：
 * - 服务端不再自动追加平台/语言规范段；21 个内容方向模板内嵌
 *   {{platformSegment}} / {{languageDirective}} 变量（管理员可自由调整）
 * - hero_visual / baiditu 标记 isHero=true（主图类：platformSegment 自动
 *   拼入平台主图规范）
 *
 * V2.4（A+详情页专属方向 + 提示词完善）：
 * - 新增 8 个 A+ 模块方向 appliesTo=[detail]（首屏横幅/卖点/场景/对比/
 *   规格/步骤/品牌/售后，模板按宽幅横向分栏构图写，定义在
 *   src/lib/product/detail-directions.ts 供单测引用）
 * - 14 个共享内容方向 appliesTo 收窄为 [suite]（存量行仍是历代默认模板时
 *   守护式收窄，超管改过的行不动）——A+ 方向池只显示新模块
 * - ai_write 系模板：商品信息固定简体中文输出（原跟随 {{outputLanguage}}）
 * - card_prompt 模板：内嵌四平台规范速查（提交时原样透传不追加规范，
 *   须在出卡阶段写入）；字数 80~150 → 120~200
 * - 四平台 generalPromptSegment 扩写、Temu/SHEIN/TikTok Shop 补
 *   heroPromptSegment（存量行仍是旧默认值时守护式升级）
 *
 * V2.5（设计感增强）：
 * - card_prompt 模板：引入「版式设计 + 摄影质感」双要素要求（分层版式/
 *   图标徽章/标注引线/数据大字/色彩系统），白底主图类方向例外保持纯净；
 *   字数 120~200 → 250~350
 * - 13 个套图方向模板（白底图除外）与 8 个 A+ 方向模板重写为设计感
 *   增强版（摄影 + 信息设计合成），存量行仍是上一代默认时守护式升级
 *
 * 0024 迁移后：运营早期手建的 7 个拼音 key 重复方向（baiditu 等，与内置
 * 方向同名/近似）已删除，其升级逻辑随之移除。
 *
 * V2.6（0025 迁移：方向池重构）：
 * - 商品套图精选 5 方向：白底图/卖点图/场景图/多角度图/尺寸尺码图
 *   （全部可见；其余 9 个已删除，能力由 A+ 模块承接），隐藏逻辑移除
 * - A+详情页补齐 14 模块（命名对齐产品参考图）：新增 多角度/工艺制作/
 *   尺寸尺码/配件-赠品/系列展示/商品成分 6 个，存量 8 个守护式同步
 *   模板/名称/描述/排序
 *
 * V2.7（全模板化）：
 * - 全部默认方向模板尾部补 {{additionalPrompt}}（严格模式：模板未引用
 *   即丢弃用户补充要求；存量行仍为 V2.6 默认时守护式升级）
 * - smart_match / card_prompt / replicate.level_* 场景默认重写：
 *   模块池/方向清单改为 {{directionPool}} / {{cards}} 变量注入，
 *   replicate 默认并入参考图语义句与平台/语言/补充要求变量；
 *   存量行仍为旧默认快照时守护式升级，超管自定义行不动
 *
 * 用法：pnpm seed:product-v2
 */
try {
  process.loadEnvFile()
} catch {
  // ignore
}

void (async () => {
  const { db } = await import("@/db/client")
  const {
    productDirections,
    platformSizeSpecs,
    productPlatforms,
    productLanguages,
    productPromptTemplates,
  } = await import("@/db/schema")
  const { PLATFORMS, LANGUAGES } = await import("@/lib/product/dictionaries")
  const { DETAIL_DIRECTIONS, LEGACY_DETAIL_TEMPLATES } = await import(
    "@/lib/product/detail-directions"
  )
  const {
    DEFAULT_PROMPT_TEMPLATES,
    PROMPT_SCENE_LABELS,
    PROMPT_SCENE_NOTES,
  } = await import("@/lib/product/prompt-defaults")


  /**
   * V2.3：内容方向模板内嵌平台/语言规范段变量（替代服务端自动追加）。
   * {{platformSegment}}=平台规范段（主图类方向自动含平台主图规范），
   * {{languageDirective}}=图内文字语言指令；管理员可在后台自由增删调整位置。
   */
  const seg = (body: string) => `{{platformSegment}} ${body} {{languageDirective}}`
  /** 反解 seg 包裹（升级判断用：存量行仍是 V2.2 裸中文正文才更新） */
  const segBody = (t: string) =>
    t.replace(/^\{\{platformSegment\}\} /, "").replace(/ \{\{languageDirective\}\}$/, "")
  /** V2.7 全模板化默认：seg 基础上尾部补补充要求变量（严格模式） */
  const segV27 = (body: string) => `${seg(body)} {{additionalPrompt}}`
  /** 反解 V2.7 尾部补充要求变量（升级判断用：存量行仍为 V2.6 默认才更新） */
  const withoutAdditional = (t: string) => t.replace(/ \{\{additionalPrompt\}\}$/, "")

  const directions = [
    {
      key: "hero_visual",
      name: "白底图",
      description: "纯白背景主图，平台核心展示位",
      promptTemplate: segV27(`纯白背景电商主图：{{productName}} 完整居中呈现，画面占比约 85%，45° 微侧机位立体展示。柔和均匀的棚拍布光，纯白无缝背景（#FFFFFF），商品投影极浅或无投影，边缘干净利落。商品材质细节与结构清晰锐利，商业产品摄影风格，画面不添加道具、水印与文字。`),
      appliesTo: ["suite"] as const,
      supportsCount: true,
      maxCount: 4,
      sortOrder: 1,
      /** 白底图类（主图）：生图注入平台主图规范（is_hero 数据化判定） */
      isHero: true,
    },
    {
      key: "core_selling",
      name: "卖点图",
      description: "单一卖点图文解析",
      promptTemplate: segV27(`卖点图文解析图：上下分层版式，上层主视觉 {{productName}} 以 45° 棚拍特写呈现、占据画面约 2/3，柔光突出材质质感与轮廓；下层为圆角卡片信息栏，核心卖点「{{topSellingPoint}}」以强调色大字标题呈现，配 3~4 条要点短句，每条带小图标徽章，辅以标注引线连接商品对应部位，卖点中的量化信息转化为数据大字强调。配色从商品取主色、搭配对比强调色，浅色渐变背景，信息层级分明，高转化电商信息图风格。`),
      appliesTo: ["suite"] as const,
      supportsCount: true,
      maxCount: 3,
      sortOrder: 2,
    },
    {
      key: "usage_scene",
      name: "场景图",
      description: "真实使用场景与氛围",
      promptTemplate: segV27(`真实使用场景图：上下分层版式，上层 {{productName}} 置于典型使用环境中（目标人群：{{targetAudience}}），生活方式摄影、自然光氛围，中景构图商品为视觉焦点，场景道具贴合使用情境、不喧宾夺主；底层横向信息栏以图标加短句列出 3 条场景收益点，主标题短语置于画面上缘留白处。色调真实温暖，画面有代入感与生活气息，文案区以色块或渐变与场景自然衔接。`),
      appliesTo: ["suite"] as const,
      supportsCount: true,
      maxCount: 3,
      sortOrder: 3,
    },
    {
      key: "multi_angle",
      name: "多角度图",
      description: "前后/侧面/细节角度",
      promptTemplate: segV27(`多角度展示图：多宫格版式（2×2 或 1+3 主次布局），{{productName}} 以正面、侧面、背面等角度分格呈现，每格配编号圆标与角度名称短标签，中央或首格为主视觉大图。各角度布光与背景保持一致，商品比例统一，浅色纯净背景，网格间距一致、版面秩序感强，帮助买家全面了解商品外观与结构。`),
      appliesTo: ["suite"] as const,
      supportsCount: true,
      maxCount: 4,
      sortOrder: 4,
    },
    {
      key: "size_chart",
      name: "尺寸尺码图",
      description: "尺寸标注示意",
      promptTemplate: segV27(`尺寸标注图：左右分栏版式，左栏 {{productName}} 45° 立体呈现，配清晰的尺寸标注线（长/宽/高）与测量数值；右栏以人形剪影或常见参照物对比呈现实际大小感知，底部横向参数栏列出关键尺寸数据。极简版式、刻度与标签易读，浅色干净背景，尺寸信息一目了然。`),
      appliesTo: ["suite"] as const,
      supportsCount: false,
      maxCount: 1,
      sortOrder: 8,
    },
    // ── A+详情页专属模块（appliesTo=[detail]，定义于 lib 供单测引用）──
    ...DETAIL_DIRECTIONS,
    // ── 产品精修（画质类）──
    {
      key: "enhance_gloss",
      name: "增强产品光泽",
      description: "提升材质光泽与质感",
      promptTemplate:
        "Enhance the product's surface gloss and material texture while keeping the product identity unchanged. Subtle specular highlights, premium finish. {{additionalPrompt}}",
      appliesTo: ["refine"] as const,
      supportsCount: false,
      maxCount: 1,
      sortOrder: 15,
    },
    {
      key: "repair_scratches",
      name: "修复划痕瑕疵",
      description: "清除划痕灰尘污点",
      promptTemplate:
        "Remove scratches, dust, smudges and minor blemishes from the product surface. Restore a flawless clean appearance without altering the product design. {{additionalPrompt}}",
      appliesTo: ["refine"] as const,
      supportsCount: false,
      maxCount: 1,
      sortOrder: 16,
    },
    {
      key: "enhance_clarity",
      name: "提升整体清晰度",
      description: "锐化与细节增强",
      promptTemplate:
        "Increase overall sharpness and clarity of the product photo, enhance edge definition and fine details. Keep a natural look without over-sharpening artifacts. {{additionalPrompt}}",
      appliesTo: ["refine"] as const,
      supportsCount: false,
      maxCount: 1,
      sortOrder: 17,
    },
    {
      key: "color_correction",
      name: "色彩校正",
      description: "白平衡与色彩还原",
      promptTemplate:
        "Apply professional color correction: fix white balance, restore true-to-life product colors, improve contrast and tonal range. Do not change the product itself. {{additionalPrompt}}",
      appliesTo: ["refine"] as const,
      supportsCount: false,
      maxCount: 1,
      sortOrder: 18,
    },
    {
      key: "fix_perspective",
      name: "修正透视变形",
      description: "矫正畸变与垂直度",
      promptTemplate:
        "Correct perspective distortion in the product photo: straighten verticals, fix lens distortion, align the product upright and symmetric as seen in real life. {{additionalPrompt}}",
      appliesTo: ["refine"] as const,
      supportsCount: false,
      maxCount: 1,
      sortOrder: 19,
    },
  ]

  const sizeSpecs = [
    {
      platformKey: "amazon",
      label: "基础A+ 标准模块图",
      width: 970,
      height: 600,
      ratioLabel: "约16:10",
      note: "Amazon 基础 A+ 标准图片模块（Web 端 970px 宽）",
      appliesTo: ["detail"] as const,
      sortOrder: 1,
    },
    {
      platformKey: "amazon",
      label: "高级A+（Web端）",
      width: 1464,
      height: 600,
      ratioLabel: "长图",
      note: "Premium A+ 桌面端全宽模块（1464px 宽）",
      appliesTo: ["detail"] as const,
      sortOrder: 2,
    },
    {
      platformKey: "amazon",
      label: "高级A+ 轮播图（Web端）",
      width: 1464,
      height: 625,
      ratioLabel: "长图",
      note: "Premium A+ 轮播模块（1464×625）",
      appliesTo: ["detail"] as const,
      sortOrder: 3,
    },
    {
      platformKey: "amazon",
      label: "A+ 移动端标准图",
      width: 600,
      height: 450,
      ratioLabel: "4:3",
      note: "A+ 移动端模块（600px 宽）",
      appliesTo: ["detail"] as const,
      sortOrder: 4,
    },
  ]

  /** smart_match 旧默认模板（升级判断用：存量行仍为此内容才更新，不覆盖超管改动） */
const LEGACY_SMART_MATCH_TEMPLATE = [
    `你是电商视觉套图策划专家。基于商品图片、卖点文案和可用模块池，规划一组电商套图。要求：`,
    `1. 分析商品外观：材质、颜色、结构、可特写细节`,
    `2. 从模块池中选择合适模块（selected: true/false）：`,
    `   - 首屏主视觉类（hero 开头）几乎必选`,
    `   - 细节/多角度类：结合商品特征选最值得展示的点`,
    `   - 规格类：商品有明显尺寸/参数信息时选`,
    `3. 为每个选中模块给出定制指导（均用{{outputLanguage}}）：`,
    `   - angle: 机位/角度建议`,
    `   - focus: 画面主体和景别`,
    `   - copyHint: 图上短文案（不超过 6 个词）`,
    `   - target: 特写对象（仅 detail 类需要）`,
    `   - count: 建议张数（1 到该模块 maxCount）`,
    `4. 未选中的模块 selected: false 即可`,
    `只输出 JSON，格式：`,
    `{"productAnalysis":{"category":"...","materials":[],"colors":[],"designFeatures":[]},`,
    ` "slots":[{"key":"...","selected":true,"angle":"...","focus":"...","copyHint":"...","count":1}]}`,
  ].join("\n")

  /** smart_match 第二代旧默认（含 7~9 总量约束、未区分定制变量语言） */
  const LEGACY_SMART_MATCH_TEMPLATE_V2 = [
    `你是电商视觉套图策划专家。基于商品图片、商品信息（卖点与要求）和可用模块池，规划一组电商套图。要求：`,
    `1. 分析商品外观：材质、颜色、结构、可特写细节`,
    `2. 从模块池中选择合适模块（selected: true/false）：`,
    `   - 首屏主视觉类（hero 开头）几乎必选`,
    `   - 细节/多角度类：结合商品特征选最值得展示的点`,
    `   - 规格类：商品有明显尺寸/参数信息时选`,
    `3. 总量约束：整组套图默认 7 张、最多 9 张；依据商品信息（卖点与要求）`,
    `   决定每个方向的具体张数分配（count，1 到该模块 maxCount）`,
    `4. 为每个选中模块给出定制指导（均用{{outputLanguage}}）：`,
    `   - angle: 机位/角度建议`,
    `   - focus: 画面主体和景别`,
    `   - copyHint: 图上短文案（不超过 6 个词）`,
    `   - target: 特写对象（仅 detail 类需要）`,
    `   - count: 建议张数（1 到该模块 maxCount）`,
    `5. 未选中的模块 selected: false 即可`,
    `只输出 JSON，格式：`,
    `{"productAnalysis":{"category":"...","materials":[],"colors":[],"designFeatures":[]},`,
    ` "slots":[{"key":"...","selected":true,"angle":"...","focus":"...","copyHint":"...","count":1}]}`,
  ].join("\n")

  /** smart_match 第三代旧默认（中文高质量版初稿：主图必选提示仍依赖 hero 前缀） */
  const LEGACY_SMART_MATCH_TEMPLATE_V3 = [
    `你是电商视觉套图策划专家。基于商品图片、商品信息（卖点与要求）和可用模块池，规划一组高转化率的电商 Listing 套图。要求：`,
    `1. 分析商品外观：材质、颜色、结构、可特写细节，写入 productAnalysis`,
    `2. 结构配比（从模块池中选择，selected: true/false）：`,
    `   - 白底图类（hero 开头）必选，是平台主图位核心`,
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
    `只输出 JSON，格式：`,
    `{"productAnalysis":{"category":"...","materials":[],"colors":[],"designFeatures":[]},`,
    ` "slots":[{"key":"...","selected":true,"angle":"...","focus":"...","copyHint":"...","count":1}]}`,
  ].join("\n")

  /** card_prompt 旧默认（无中文正文约束、画面要素指导较弱） */
  const LEGACY_CARD_PROMPT_TEMPLATE = [
    `你是资深电商摄影指导与提示词工程师。基于商品信息（卖点与要求）与给定的图片方向，为每个方向撰写一条可直接用于生图模型的画面提示词。要求：`,
    `1. 每条提示词是一段完整的画面描述：主体、构图/机位、材质光感、背景与氛围，具体可执行`,
    `2. 结合参考图中的商品实际外观（材质/颜色/结构）组织画面，不虚构与商品冲突的细节`,
    `3. 图内文字（如有）使用{{outputLanguage}}，短语精炼`,
    `4. 遵循 {{platformLabel}} 平台的视觉偏好`,
    `5. 同一方向的多张卡片，画面提示词需有差异（角度/构图/侧重点）`,
    `只输出 JSON，index 与用户消息中方向的序号一一对应，逐条返回不要遗漏：`,
    `{"prompts":[{"index":1,"prompt":"..."},{"index":2,"prompt":"..."}]}`,
  ].join("\n")

  /** card_prompt V2.4 旧默认（有平台规范速查、120~200 字；V2.5 升级为设计感版 250~350 字） */
  const LEGACY_CARD_PROMPT_TEMPLATE_V3 = [
    `你是资深电商摄影指导与 AI 生图提示词工程师，擅长为跨境电商 Listing 打造高点击率商品图。基于商品信息（卖点与要求）、参考图与给定的图片方向，为每个方向撰写一条可直接用于生图模型的画面提示词。要求：`,
    `1. 语言：画面提示词正文一律用简体中文撰写；仅图内出现的文字（卖点短语、标签等）使用{{outputLanguage}}`,
    `2. 平台规范（重要——提示词提交时原样透传，服务端不会追加任何规范，必须在这一步写进卡片）：按 {{platformLabel}} 平台把适用规范要点直接写入提示词对应位置：`,
    `   - 亚马逊 Amazon：白底图/主图类须纯白背景（#FFFFFF）、商品占比 85% 以上、无边框/logo/水印/道具/促销文字；其余图遵循 A+ 内容规范：版面干净、信息清晰、装饰克制`,
    `   - Temu：背景干净明快、主体突出、色彩鲜亮，突出性价比与促销氛围，无水印与杂乱贴纸`,
    `   - SHEIN：潮流年轻化视觉、时尚感构图、配色紧跟流行趋势，画面轻盈通透`,
    `   - TikTok Shop：社交原生风格、动感强、对比鲜明、第一眼抓眼球，无水印边框`,
    `   若平台不在上述清单，按该平台通行的电商图片规范执行`,
    `3. 每条提示词按画面要素组织，具体可执行：`,
    `   - 主体与商品还原：商品外观、材质、颜色须与参考图一致，点出关键细节`,
    `   - 构图与景别：明确景别（特写/近景/中景/全景）与机位（平视/45°侧/俯拍/仰拍）、主体位置与画面占比`,
    `   - 光线与质感：布光方式（柔光棚拍/侧逆光/自然光）与材质表现（哑光/镜面高光/织物纹理）`,
    `   - 背景与配色：背景样式、色彩搭配与整体色调`,
    `   - 氛围与风格：画面情绪与摄影风格（商业棚拍/生活方式摄影/简约电商风）`,
    `4. 结合参考图中商品的实际外观组织画面，不虚构与商品冲突的细节与功能`,
    `5. 图内文字（如有）短语精炼，遵循 {{platformLabel}} 平台的视觉偏好与图片规范`,
    `6. 同一方向的多张卡片，须在机位、构图或侧重点上明显区分`,
    `7. 禁止堆砌"高清、精美、专业"等空洞形容词；每条 120~200 字`,
    `只输出 JSON，index 与用户消息中方向的序号一一对应，逐条返回不要遗漏：`,
    `{"prompts":[{"index":1,"prompt":"..."},{"index":2,"prompt":"..."}]}`,
  ].join("\n")

  /**
   * card_prompt V2.4 运营变体（在 V2.4 基础上字数档改为 200~300、
   * Amazon 行有截断；与 V2.5 升级方向一致，纳入升级快照一并覆盖）
   */
  const LEGACY_CARD_PROMPT_TEMPLATE_V3B = [
    `你是资深电商摄影指导与 AI 生图提示词工程师，擅长为跨境电商 Listing 打造高点击率商品图。基于商品信息（卖点与要求）、参考图与给定的图片方向，为每个方向撰写一条可直接用于生图模型的画面提示词。要求：`,
    `1. 语言：画面提示词正文一律用简体中文撰写；仅图内出现的文字（卖点短语、标签等）使用{{outputLanguage}}`,
    `2. 平台规范（重要——提示词提交时原样透传，服务端不会追加任何规范，必须在这一步写进卡片）：按 {{platformLabel}} 平台把适用规范要点直接写入提示词对应位置：`,
    `   - 亚马逊 Amazon：白底图/主图类须纯白背景（#FFFFFF）、商品占比 85% 以上、无边框/logo/水印/道具/促销文字；其余图遵循 A+ 内容规范：版面干净、信息清晰、`,
    `   - Temu：背景干净明快、主体突出、色彩鲜亮，突出性价比与促销氛围，无水印与杂乱贴纸`,
    `   - SHEIN：潮流年轻化视觉、时尚感构图、配色紧跟流行趋势，画面轻盈通透`,
    `   - TikTok Shop：社交原生风格、动感强、对比鲜明、第一眼抓眼球，无水印边框`,
    `   若平台不在上述清单，按该平台通行的电商图片规范执行`,
    `3. 每条提示词按画面要素组织，具体可执行：`,
    `   - 主体与商品还原：商品外观、材质、颜色须与参考图一致，点出关键细节`,
    `   - 构图与景别：明确景别（特写/近景/中景/全景）与机位（平视/45°侧/俯拍/仰拍）、主体位置与画面占比`,
    `   - 光线与质感：布光方式（柔光棚拍/侧逆光/自然光）与材质表现（哑光/镜面高光/织物纹理）`,
    `   - 背景与配色：背景样式、色彩搭配与整体色调`,
    `   - 氛围与风格：画面情绪与摄影风格（商业棚拍/生活方式摄影/简约电商风）`,
    `4. 结合参考图中商品的实际外观组织画面，不虚构与商品冲突的细节与功能`,
    `5. 图内文字（如有）短语精炼，遵循 {{platformLabel}} 平台的视觉偏好与图片规范`,
    `6. 同一方向的多张卡片，须在机位、构图或侧重点上明显区分`,
    `7. 禁止堆砌"高清、精美、专业"等空洞形容词；每条 200~300 字`,
    `只输出 JSON，index 与用户消息中方向的序号一一对应，逐条返回不要遗漏：`,
    `{"prompts":[{"index":1,"prompt":"..."},{"index":2,"prompt":"..."}]}`,
  ].join("\n")

  /** ai_write 系旧默认的编号格式契约尾段（V2.4 起正文不变，快照供升级比对） */
  const LEGACY_BRIEF_FORMAT_RULES = [
    `必须严格按以下编号格式输出（编号与标题原样保留，内容写在冒号后）：`,
    `1.商品名称：简洁准确，符合品类命名习惯`,
    `2.核心卖点：4-6 条，每条一行并以 - 开头，不超过 12 个词，具体、可验证、突出差异化`,
    `3.适用人群：一句话`,
    `4.使用场景：一句话描述典型使用情境`,
    `5.规格参数：2-4 条，每条一行并以 - 开头；无明确参数时写"无"`,
    `6.画面建议：一句话（材质/光感/构图）`,
    `只输出 JSON，格式：{"brief":"上述编号格式的完整文本"}`,
  ].join("\n")

  /** ai_write 旧默认（商品信息跟随 {{outputLanguage}} 输出，V2.4 改为固定简体中文） */
  const LEGACY_AI_WRITE_SUITE = [
    `你是跨境电商资深商品文案策划。分析用户提供的商品图片（如有）与补充说明，为 {{platformLabel}} 平台撰写商品信息。`,
    `输出语言：{{outputLanguage}}；遵循该平台的 Listing 文案规范。`,
    LEGACY_BRIEF_FORMAT_RULES,
  ].join("\n")

  const LEGACY_AI_WRITE_DETAIL = [
    `你是跨境电商资深商品文案策划。分析用户提供的商品图片（如有）与补充说明，为 {{platformLabel}} 平台的 A+ 详情页撰写商品信息。`,
    `输出语言：{{outputLanguage}}；内容面向 A+ 内容模块文案，条目可更侧重参数与场景说明。`,
    LEGACY_BRIEF_FORMAT_RULES,
  ].join("\n")

  /** smart_match V2.6 旧默认（模块池由系统拼入用户消息；V2.7 改为 {{directionPool}} 变量注入） */
  const LEGACY_SMART_MATCH_TEMPLATE_V4 = [
    `你是电商视觉套图策划专家。基于商品图片、商品信息（卖点与要求）和可用模块池，规划一组高转化率的电商 Listing 套图。要求：`,
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
    `只输出 JSON，格式：`,
    `{"productAnalysis":{"category":"...","materials":[],"colors":[],"designFeatures":[]},`,
    ` "slots":[{"key":"...","selected":true,"angle":"...","focus":"...","copyHint":"...","count":1}]}`,
  ].join("\n")

  /** card_prompt V2.5 旧默认（方向清单由系统拼入用户消息；V2.7 改为 {{cards}}/{{cardCount}} 变量注入） */
  const LEGACY_CARD_PROMPT_TEMPLATE_V4 = [
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
    `只输出 JSON，index 与用户消息中方向的序号一一对应，逐条返回不要遗漏：`,
    `{"prompts":[{"index":1,"prompt":"..."},{"index":2,"prompt":"..."}]}`,
  ].join("\n")

  /** replicate 旧默认（纯片段：服务端拼接平台/语言段与参考图语义句；V2.7 并入完整模板） */
  const LEGACY_REPLICATE_STYLE =
    "Match the visual style, mood and color palette of the style reference image, while composing an original layout featuring the provided product. "
  const LEGACY_REPLICATE_STRICT =
    "Closely replicate the composition, layout, text placement and overall design of the style reference image, substituting the product with the provided one. "

  /** card_prompt V2.3 旧默认（无平台规范速查、字数 80~150） */
  const LEGACY_CARD_PROMPT_TEMPLATE_V2 = [
    `你是资深电商摄影指导与 AI 生图提示词工程师，擅长为跨境电商 Listing 打造高点击率商品图。基于商品信息（卖点与要求）、参考图与给定的图片方向，为每个方向撰写一条可直接用于生图模型的画面提示词。要求：`,
    `1. 语言：画面提示词正文一律用简体中文撰写；仅图内出现的文字（卖点短语、标签等）使用{{outputLanguage}}`,
    `2. 每条提示词按画面要素组织，具体可执行：`,
    `   - 主体与商品还原：商品外观、材质、颜色须与参考图一致，点出关键细节`,
    `   - 构图与景别：明确景别（特写/近景/中景/全景）与机位（平视/45°侧/俯拍/仰拍）、主体位置与画面占比`,
    `   - 光线与质感：布光方式（柔光棚拍/侧逆光/自然光）与材质表现（哑光/镜面高光/织物纹理）`,
    `   - 背景与配色：背景样式、色彩搭配与整体色调`,
    `   - 氛围与风格：画面情绪与摄影风格（商业棚拍/生活方式摄影/简约电商风）`,
    `3. 结合参考图中商品的实际外观组织画面，不虚构与商品冲突的细节与功能`,
    `4. 图内文字（如有）短语精炼，遵循 {{platformLabel}} 平台的视觉偏好与图片规范`,
    `5. 同一方向的多张卡片，须在机位、构图或侧重点上明显区分`,
    `6. 禁止堆砌"高清、精美、专业"等空洞形容词；每条 80~150 字`,
    `只输出 JSON，index 与用户消息中方向的序号一一对应，逐条返回不要遗漏：`,
    `{"prompts":[{"index":1,"prompt":"..."},{"index":2,"prompt":"..."}]}`,
  ].join("\n")

  /** 旧英文方向模板（升级判断用：存量行仍为此内容才更新为中文化新默认） */
  const LEGACY_DIRECTION_TEMPLATES: Record<string, string> = {
    hero_visual: `Hero shot of {{productName}}. The product fills 70% of the frame, centered composition with strong visual impact. Key benefit text overlay: "{{topSellingPoint}}".`,
    core_selling: `Product feature callout image for {{productName}}: product on one side, clean infographic annotation highlighting "{{topSellingPoint}}" with icon badges and short supporting copy: {{sellingPoints}}.`,
    usage_scene: `{{productName}} in a real-life usage scenario for {{targetAudience}}, lifestyle photography with natural ambient light, environment conveying the product's use context.`,
    multi_angle: `Multi-angle view of {{productName}}, showing a different side (front / side / back / top), consistent lighting and background across angles.`,
    size_chart: `Size chart infographic for {{productName}}: product outline with clear dimension lines and measurements, minimalist layout, easy-to-read labels.`,
  }

  /** V2.4 上一代方向模板快照（带规范段变量包裹；V2.5 设计感升级判断用）：
   *  存量行仍为上一代默认时升级为设计感增强版，超管改过的行不动 */
  const PREVIOUS_DIRECTION_TEMPLATES: Record<string, string> = {
    core_selling: seg(`卖点图文解析图：{{productName}} 在画面一侧完整清晰呈现，另一侧以图标徽章与短文案突出核心卖点「{{topSellingPoint}}」，辅助说明：{{sellingPoints}}。版式简洁有序，信息层级分明，背景干净，配色与商品色调统一，电商详情页信息图风格，图上文案精炼直击痛点。`),
    usage_scene: seg(`真实使用场景图：{{productName}} 置于典型使用环境中（目标人群：{{targetAudience}}），生活方式摄影风格，自然光或环境光氛围。中景构图，商品为视觉焦点，场景道具贴合使用情境、不喧宾夺主，色调真实温暖，画面有生活气息与代入感。`),
    multi_angle: seg(`多角度展示图：{{productName}} 以正面、侧面、背面等角度完整呈现，各角度布光与背景保持一致，商品比例统一，画面干净有序，帮助买家全面了解商品外观与结构。`),
    size_chart: seg(`尺寸标注图：{{productName}} 外观轮廓配清晰的尺寸标注线与测量数值，极简版式，刻度与标签易读，浅色干净背景，尺寸信息一目了然。`),
  }

  /** V2.2 改名的核心方向（旧名 → 新名；配套自定义配置仅展示 4 张卡片） */
  const RENAMED_DIRECTION_KEYS = new Set([
    "hero_visual",
    "core_selling",
    "usage_scene",
  ])


async function main() {
    for (const d of directions) {
      await db
        .insert(productDirections)
        .values({
          ...d,
          appliesTo: [...d.appliesTo],
        })
        .onConflictDoNothing({ target: productDirections.key })
    }
    console.log(`✓ 方向种子完成（${directions.length} 条，已存在则跳过）`)

    // 套图结构配置「白底图」支持多张：已存在行单独提升上限（其余行仍不覆盖超管修改）
    const { eq, inArray } = await import("drizzle-orm")
    await db
      .update(productDirections)
      .set({ maxCount: 4 })
      .where(eq(productDirections.key, "hero_visual"))
    console.log("✓ hero_visual maxCount 已提升至 4（白底图多张）")

    // V2.3：主图类判定数据化（is_hero 列）——标记内置白底图方向
    // （历史后台自定义 key baiditu 已随 0024 迁移删除；key 集合兜底见 prompt.ts）
    await db
      .update(productDirections)
      .set({ isHero: true })
      .where(inArray(productDirections.key, ["hero_visual"]))
    console.log("✓ hero_visual 已标记为主图类（isHero）")

    // ── V2.2/V2.3：存量方向行升级（中文化 + 内嵌规范段变量 + 核心方向改名）──
    // 模板仍是旧英文默认或 V2.2 裸中文正文的行才更新（不覆盖超管后续修改）；
    // 新装库由上方 insert 直接写入新默认，此处天然跳过
    const dirRows = await db
      .select({
        key: productDirections.key,
        promptTemplate: productDirections.promptTemplate,
        appliesTo: productDirections.appliesTo,
        name: productDirections.name,
        description: productDirections.description,
        sortOrder: productDirections.sortOrder,
      })
      .from(productDirections)
    const dirRowByKey = new Map(dirRows.map((r) => [r.key, r]))
    let dirUpgraded = 0
    for (const d of directions) {
      const row = dirRowByKey.get(d.key)
      if (!row) continue
      // 已是当前默认则跳过（refine 画质方向不带 seg 包裹，
      // 裸正文比对会恒等于自身导致每轮空转）
      if (row.promptTemplate === d.promptTemplate) continue
      const isLegacy =
        row.promptTemplate === LEGACY_DIRECTION_TEMPLATES[d.key] ||
        row.promptTemplate === PREVIOUS_DIRECTION_TEMPLATES[d.key] ||
        // V2.6 默认（未含补充要求变量）或 V2.2 裸中文正文 → 升级为 V2.7 默认
        row.promptTemplate === withoutAdditional(d.promptTemplate) ||
        row.promptTemplate === segBody(withoutAdditional(d.promptTemplate))
      if (!isLegacy) continue
      await db
        .update(productDirections)
        .set(
          RENAMED_DIRECTION_KEYS.has(d.key)
            ? {
                promptTemplate: d.promptTemplate,
                name: d.name,
                description: d.description,
              }
            : { promptTemplate: d.promptTemplate },
        )
        .where(eq(productDirections.key, d.key))
      dirUpgraded++
    }
    console.log(
      `✓ 方向模板已升级（内嵌平台/语言规范段变量，${dirUpgraded} 条，超管改过的行跳过）`,
    )

    // V2.4：14 个共享内容方向 appliesTo 收窄为 [suite]，A+ 方向池改用
    // detail 专属模块。仅收窄「模板仍是历代默认值」的行（dirRowByKey 为
    // 模板升级前快照，恰好覆盖 英文旧版/裸中文/当前默认 三代）；
    // 超管改过模板的行视为运营数据，保持其作用域不动
    const suiteContentKeys = new Set(
      directions
        .filter((d) => (d.appliesTo as readonly string[]).includes("suite"))
        .map((d) => d.key),
    )
    let scopeNarrowed = 0
    for (const d of directions) {
      if (!suiteContentKeys.has(d.key)) continue
      const row = dirRowByKey.get(d.key)
      if (!row) continue
      if (!(row.appliesTo ?? []).includes("detail")) continue
      const isDefaultish =
        row.promptTemplate === LEGACY_DIRECTION_TEMPLATES[d.key] ||
        row.promptTemplate === PREVIOUS_DIRECTION_TEMPLATES[d.key] ||
        row.promptTemplate === withoutAdditional(d.promptTemplate) ||
        row.promptTemplate === segBody(withoutAdditional(d.promptTemplate)) ||
        row.promptTemplate === d.promptTemplate
      if (!isDefaultish) continue
      await db
        .update(productDirections)
        .set({ appliesTo: ["suite"], updatedAt: new Date() })
        .where(eq(productDirections.key, d.key))
      scopeNarrowed++
    }
    console.log(
      `✓ 共享方向 appliesTo 已收窄为 [suite]（${scopeNarrowed} 条，超管改过的行跳过）`,
    )

    // V2.5/V2.6：A+ 方向守护升级——模板仍是默认值（V2.4 上一代或当前版）时
    // 同步模板/名称/描述/排序（V2.6 命名对齐 14 模块参考图）；超管改过模板的行跳过
    let detailUpgraded = 0
    for (const d of DETAIL_DIRECTIONS) {
      const row = dirRowByKey.get(d.key)
      if (!row) continue
      const isDefaultish =
        row.promptTemplate === LEGACY_DETAIL_TEMPLATES[d.key] ||
        row.promptTemplate === withoutAdditional(d.promptTemplate) ||
        row.promptTemplate === d.promptTemplate
      if (!isDefaultish) continue
      if (
        row.promptTemplate === d.promptTemplate &&
        row.name === d.name &&
        (row.description ?? "") === d.description &&
        row.sortOrder === d.sortOrder
      ) {
        continue
      }
      await db
        .update(productDirections)
        .set({
          promptTemplate: d.promptTemplate,
          name: d.name,
          description: d.description,
          sortOrder: d.sortOrder,
          updatedAt: new Date(),
        })
        .where(eq(productDirections.key, d.key))
      detailUpgraded++
    }
    console.log(
      `✓ A+ 方向已同步（模板/命名/排序，${detailUpgraded} 条，超管改过的行跳过）`,
    )


    for (const s of sizeSpecs) {
      await db
        .insert(platformSizeSpecs)
        .values({ ...s, appliesTo: [...s.appliesTo] })
        .onConflictDoNothing({
          target: [platformSizeSpecs.platformKey, platformSizeSpecs.label],
        })
    }
    console.log(`✓ 尺寸规范种子完成（${sizeSpecs.length} 条，已存在则跳过）`)

    // ── V2.1：平台 / 语言 / 提示词模板（回退常量的 DB 化初始数据）──
    for (const [i, p] of PLATFORMS.entries()) {
      await db
        .insert(productPlatforms)
        .values({
          key: p.value,
          label: p.label,
          heroPromptSegment: p.heroPromptSegment ?? null,
          generalPromptSegment: p.generalPromptSegment ?? null,
          sortOrder: i + 1,
        })
        .onConflictDoNothing({ target: productPlatforms.key })
    }
    console.log(`✓ 上架平台种子完成（${PLATFORMS.length} 条）`)

    // V2.4：平台规范段扩写守护升级——仍是旧默认值的字段才更新（逐字段判断，
    // 超管改过任一段则该段保持运营数据不动）
    const LEGACY_PLATFORM_SEGMENTS: Record<
      string,
      { hero: string | null; general: string | null }
    > = {
      amazon: {
        hero: "Amazon main image rules: pure white background (#FFFFFF), no logos, watermarks or extra props, product fills 85%+ of the frame. ",
        general:
          "Follow Amazon A+ content visual guidelines: clean, informative, minimal decorative clutter. ",
      },
      temu: {
        hero: null,
        general:
          "Follow Temu listing style: vivid colors, price-value feel, attention-grabbing composition. ",
      },
      shein: {
        hero: null,
        general:
          "Follow SHEIN listing style: trendy, youthful, fashion-forward visual mood. ",
      },
      tiktok_shop: {
        hero: null,
        general:
          "Follow TikTok Shop style: dynamic, social-media-native, bold and engaging. ",
      },
    }
    const platformRows = await db
      .select({
        key: productPlatforms.key,
        heroPromptSegment: productPlatforms.heroPromptSegment,
        generalPromptSegment: productPlatforms.generalPromptSegment,
      })
      .from(productPlatforms)
    let platformUpgraded = 0
    for (const p of PLATFORMS) {
      const legacy = LEGACY_PLATFORM_SEGMENTS[p.value]
      if (!legacy) continue
      const row = platformRows.find((r) => r.key === p.value)
      if (!row) continue
      const patch: Partial<{
        heroPromptSegment: string | null
        generalPromptSegment: string | null
      }> = {}
      if (
        row.generalPromptSegment === legacy.general &&
        row.generalPromptSegment !== (p.generalPromptSegment ?? null)
      ) {
        patch.generalPromptSegment = p.generalPromptSegment ?? null
      }
      if (
        row.heroPromptSegment === legacy.hero &&
        row.heroPromptSegment !== (p.heroPromptSegment ?? null)
      ) {
        patch.heroPromptSegment = p.heroPromptSegment ?? null
      }
      if (Object.keys(patch).length === 0) continue
      await db
        .update(productPlatforms)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(productPlatforms.key, p.value))
      console.log(`✓ 平台规范段已升级（${p.label}：${Object.keys(patch).join("/")}）`)
      platformUpgraded++
    }
    if (platformUpgraded === 0) {
      console.log("✓ 平台规范段无需升级（均为最新或超管已自定义）")
    }

    for (const [i, l] of LANGUAGES.entries()) {
      await db
        .insert(productLanguages)
        .values({
          key: l.value,
          label: l.label,
          outputName: l.outputName,
          imageDirective: l.imageDirective,
          sortOrder: i + 1,
        })
        .onConflictDoNothing({ target: productLanguages.key })
    }
    console.log(`✓ 语言种子完成（${LANGUAGES.length} 条）`)

    const sceneOrder = Object.keys(DEFAULT_PROMPT_TEMPLATES)
    for (const [i, scene] of sceneOrder.entries()) {
      await db
        .insert(productPromptTemplates)
        .values({
          scene,
          name: PROMPT_SCENE_LABELS[scene] ?? scene,
          template: DEFAULT_PROMPT_TEMPLATES[scene]!,
          note: PROMPT_SCENE_NOTES[scene] ?? null,
          sortOrder: i + 1,
        })
        .onConflictDoNothing({ target: productPromptTemplates.scene })
    }
    console.log(`✓ 提示词模板种子完成（${sceneOrder.length} 条）`)

    // 对话模板升级（smart_match 历代旧默认 / card_prompt 旧默认 → 中文高质量版）：
    // 仅当存量行仍为旧默认值时更新，不覆盖超管改动
    const sceneLegacyUpgrades: Array<{ scene: string; legacies: string[] }> = [
      {
        scene: "suite.smart_match",
        legacies: [
          LEGACY_SMART_MATCH_TEMPLATE,
          LEGACY_SMART_MATCH_TEMPLATE_V2,
          LEGACY_SMART_MATCH_TEMPLATE_V3,
          LEGACY_SMART_MATCH_TEMPLATE_V4,
        ],
      },
      {
        scene: "suite.ai_write",
        legacies: [LEGACY_AI_WRITE_SUITE],
      },
      {
        scene: "detail.ai_write",
        legacies: [LEGACY_AI_WRITE_DETAIL],
      },
      {
        scene: "suite.card_prompt",
        legacies: [
          LEGACY_CARD_PROMPT_TEMPLATE,
          LEGACY_CARD_PROMPT_TEMPLATE_V2,
          LEGACY_CARD_PROMPT_TEMPLATE_V3,
          LEGACY_CARD_PROMPT_TEMPLATE_V3B,
          LEGACY_CARD_PROMPT_TEMPLATE_V4,
        ],
      },
      {
        scene: "replicate.level_style",
        legacies: [LEGACY_REPLICATE_STYLE],
      },
      {
        scene: "replicate.level_strict",
        legacies: [LEGACY_REPLICATE_STRICT],
      },
    ]
    for (const { scene, legacies } of sceneLegacyUpgrades) {
      const [row] = await db
        .select({
          id: productPromptTemplates.id,
          template: productPromptTemplates.template,
        })
        .from(productPromptTemplates)
        .where(eq(productPromptTemplates.scene, scene))
        .limit(1)
      if (row && legacies.includes(row.template)) {
        await db
          .update(productPromptTemplates)
          .set({
            template: DEFAULT_PROMPT_TEMPLATES[scene]!,
            note: PROMPT_SCENE_NOTES[scene] ?? null,
            updatedAt: new Date(),
          })
          .where(eq(productPromptTemplates.id, row.id))
        console.log(`✓ ${scene} 模板已升级（中文高质量版）`)
      }
    }

    // 风格基座已从 prompt 组装中移除，清理两个废弃场景的存量行
    await db
      .delete(productPromptTemplates)
      .where(
        inArray(productPromptTemplates.scene, [
          "suite.style_base",
          "detail.style_base",
        ]),
      )
    console.log("✓ 已清理废弃的风格基座场景行")

    process.exit(0)
  }

  main().catch((err) => {
    console.error("种子失败:", err)
    process.exit(1)
  })
})()
