/**
 * A+详情页专属方向的种子默认模板（V2.6：14 模块全集，命名对齐产品参考图）
 *
 * 独立于 seed 脚本存放以便单测引用（seed 脚本 import 即执行建连）。
 * appliesTo 固定 ["detail"]：A+ 方向池只显示这些模块（每方向固定 1 张），
 * 商品套图方向池（seed 内联的 5 个精选方向）不受影响。
 *
 * 14 模块与参考图一一对应：首屏主视觉/核心卖点图/使用场景图/多角度图/
 * 效果对比图/品牌故事图/工艺制作图/规格参数表/尺寸尺码图/配件-赠品图/
 * 系列展示图/商品成分图/售后保障图/使用建议图（sortOrder 20~33）。
 *
 * 模板契约（buildDirectionPrompt，V2.7 全模板化）：
 * - 内嵌 {{platformSegment}} / {{languageDirective}} / {{additionalPrompt}}，
 *   模板未引用的变量不注入（严格模式，补充要求亦然）；
 * - 商品变量 {{productName}} / {{sellingPoints}} / {{topSellingPoint}} /
 *   {{targetAudience}} 缺失时替换为空串，句子自然省略；
 * - 构图面向 A+ 宽幅横图（如 Amazon 970×600 / 1464×600）；
 * - 按「摄影 + 信息设计合成」写：分层版式、图标徽章、标注引线等设计元素。
 *
 * LEGACY_DETAIL_TEMPLATES 为 V2.4 快照（仅首批 8 个 key）：seed 守护升级
 * 判断用，存量行仍是默认（上一代或当前）时同步模板/名称/描述/排序。
 */

export interface DetailDirectionSeed {
  key: string
  name: string
  description: string
  promptTemplate: string
  appliesTo: ["detail"]
  /** A+详情页每方向固定 1 张，无数量调节 */
  supportsCount: false
  maxCount: 1
  sortOrder: number
}

/** 规范段变量包裹（V2.6 及之前各代快照用，不含补充要求变量） */
const seg = (body: string) => `{{platformSegment}} ${body} {{languageDirective}}`
/** V2.7 全模板化默认：尾部补充要求变量（模板未引用即丢弃，严格模式） */
const segV27 = (body: string) => `${seg(body)} {{additionalPrompt}}`

export const DETAIL_DIRECTIONS: DetailDirectionSeed[] = [
  {
    key: "detail_hero_banner",
    name: "首屏主视觉",
    description: "传递核心价值",
    promptTemplate: segV27(
      `A+ 详情页首屏主视觉横幅：宽幅横向左右分栏构图，主栏 {{productName}} 以 45° 棚拍主视觉呈现、占画面约 3/5，柔光刻画材质与轮廓质感，商品投影干净；信息栏以品牌色块或浅色渐变为底，核心卖点「{{topSellingPoint}}」以强调色大字主标题呈现，配一行副标题与 2~3 条带小图标徽章的要点短句。视觉层级分明，第一眼传递品牌调性与商品价值，留白克制、元素不堆砌。`,
    ),
    appliesTo: ["detail"],
    supportsCount: false,
    maxCount: 1,
    sortOrder: 20,
  },
  {
    key: "detail_selling_points",
    name: "核心卖点图",
    description: "突出差异化优势",
    promptTemplate: segV27(
      `A+ 详情页核心卖点模块图：宽幅横向上下分层构图，上层 {{productName}} 居中 45° 棚拍呈现配柔和投影；下层以 3~4 个等宽圆角卡片分栏呈现核心卖点：{{sellingPoints}}，每栏配图标徽章、短标题与一句说明，量化卖点转化为数据大字强调（如续航时长、容量、功率）。模块化栅格排版、栏间距一致，信息层级清晰，配色从商品取主色、搭配对比强调色点缀标题与图标，高转化电商信息图风格。`,
    ),
    appliesTo: ["detail"],
    supportsCount: false,
    maxCount: 1,
    sortOrder: 21,
  },
  {
    key: "detail_scene",
    name: "使用场景图",
    description: "呈现真实使用场景",
    promptTemplate: segV27(
      `A+ 详情页场景演示模块图：宽幅横向构图，{{productName}} 置于典型使用环境中（目标人群：{{targetAudience}}），生活方式摄影、自然光或环境光氛围，中景构图商品为视觉焦点，场景道具贴合使用情境、不喧宾夺主；画面一侧留出文案区放主标题短语与 2~3 条场景收益短句（每条带小图标）。色调真实温暖、有代入感，文案区与画面以色块或渐变自然衔接。`,
    ),
    appliesTo: ["detail"],
    supportsCount: false,
    maxCount: 1,
    sortOrder: 22,
  },
  {
    key: "detail_multi_angle",
    name: "多角度图",
    description: "多角度呈现外观结构",
    promptTemplate: segV27(
      `A+ 详情页多角度展示模块图：宽幅横向多宫格版式，{{productName}} 以正面、侧面、背面等角度分格呈现，每格配编号圆标与角度名称短标签，首格为主视觉大图。各角度布光与背景保持一致，商品比例统一，浅色纯净背景，网格间距一致、版面秩序感强，帮助买家全面了解商品外观与结构。`,
    ),
    appliesTo: ["detail"],
    supportsCount: false,
    maxCount: 1,
    sortOrder: 23,
  },
  {
    key: "detail_comparison",
    name: "效果对比图",
    description: "使用前后对比",
    promptTemplate: segV27(
      `A+ 详情页对比模块图：宽幅横向左右分屏构图，中缝以强调色 VS 圆标分隔，左侧呈现普通方案或使用前痛点（灰调弱化处理），右侧呈现 {{productName}} 的优势效果（明亮饱和强化），顶部主标题点明对比主题并以强调色突出「{{topSellingPoint}}」。两侧同机位同光线保证可比性，对比维度配图标与一行结论短句，优势项视觉强调，差异直观易读。`,
    ),
    appliesTo: ["detail"],
    supportsCount: false,
    maxCount: 1,
    sortOrder: 24,
  },
  {
    key: "detail_brand",
    name: "品牌故事图",
    description: "品牌理念与工艺传承",
    promptTemplate: segV27(
      `A+ 详情页品牌故事横幅：宽幅电影感构图，{{productName}} 与体现品牌调性的场景元素共同构成画面，侧逆光与浅景深营造高级氛围，画面一侧留出品牌主张文案区：一句品牌理念大字 + 一行副文案，文字与画面以暗色渐变或留白自然过渡。整体色调统一克制，画面情绪与品牌气质一致，构图克制高级。`,
    ),
    appliesTo: ["detail"],
    supportsCount: false,
    maxCount: 1,
    sortOrder: 25,
  },
  {
    key: "detail_craftsmanship",
    name: "工艺制作图",
    description: "制造工艺与品质细节",
    promptTemplate: segV27(
      `A+ 详情页工艺制作模块图：宽幅横向主副图分层版式，主图 {{productName}} 关键工艺部位微距特写，侧逆光刻画材质肌理、做工精度与结构细节，浅景深虚化工坊氛围背景；副图区以 2~3 个小圆图配标注引线，指出工艺细节并各配一句品质短句。整体传递匠心与高品质感，标注风格统一、版面克制。`,
    ),
    appliesTo: ["detail"],
    supportsCount: false,
    maxCount: 1,
    sortOrder: 26,
  },
  {
    key: "detail_spec",
    name: "规格/参数表",
    description: "关键参数图表化",
    promptTemplate: segV27(
      `A+ 详情页规格参数模块图：宽幅横向左右分栏构图，左栏 {{productName}} 45° 棚拍呈现配柔和投影；右栏参数表以双列栅格呈现关键参数：{{sellingPoints}}，参数名与数值左右对齐、行间以细分隔线区分，重点参数以强调色数字突出。扁平化信息图风格，浅色干净底色，配色与品牌调性统一，易读性优先、版面不拥挤。`,
    ),
    appliesTo: ["detail"],
    supportsCount: false,
    maxCount: 1,
    sortOrder: 27,
  },
  {
    key: "detail_size_chart",
    name: "尺寸尺码图",
    description: "尺寸标注示意",
    promptTemplate: segV27(
      `A+ 详情页尺寸尺码模块图：宽幅横向左右分栏版式，左栏 {{productName}} 45° 立体呈现，配清晰的尺寸标注线（长/宽/高）与测量数值；右栏以人形剪影或常见参照物对比呈现实际大小感知，底部横向参数栏列出关键尺寸数据。极简版式、刻度与标签易读，浅色干净背景，尺寸信息一目了然。`,
    ),
    appliesTo: ["detail"],
    supportsCount: false,
    maxCount: 1,
    sortOrder: 28,
  },
  {
    key: "detail_accessories",
    name: "配件-赠品图",
    description: "包装清单全家福",
    promptTemplate: segV27(
      `A+ 详情页配件-赠品模块图：宽幅横向俯拍平铺（Flat-lay）版式，{{productName}} 居中，全部随附配件与赠品围绕整齐陈列、间距均匀互不重叠，每件物品配标注引线与名称短标签，赠品以强调色角标突出。物品排列有序，浅色干净背景配轻投影，画面整洁、清单感强，帮助买家确认包装内容。`,
    ),
    appliesTo: ["detail"],
    supportsCount: false,
    maxCount: 1,
    sortOrder: 29,
  },
  {
    key: "detail_series_display",
    name: "系列展示图",
    description: "同系列多型号陈列",
    promptTemplate: segV27(
      `A+ 详情页系列展示模块图：宽幅横向陈列版式，{{productName}} 同系列多个型号或配色等比例一字排开（主推款居中放大），每款下方配型号名称短标签与一行差异点说明。布光与背景统一，浅色渐变底，排列节奏整齐有序，呈现系列完整性与一致的设计语言。`,
    ),
    appliesTo: ["detail"],
    supportsCount: false,
    maxCount: 1,
    sortOrder: 30,
  },
  {
    key: "detail_ingredients",
    name: "商品成分图",
    description: "成分/材质构成",
    promptTemplate: segV27(
      `A+ 详情页商品成分模块图：宽幅横向左右分栏版式，左栏 {{productName}} 棚拍特写呈现，右栏以图标加短句列出关键成分或材质，每项配含量或产地标注，项间以细分隔线分隔；用标注引线把成分与商品对应部位关联。版式清爽、信息直观可信，浅色干净背景，配色与商品色调统一。`,
    ),
    appliesTo: ["detail"],
    supportsCount: false,
    maxCount: 1,
    sortOrder: 31,
  },
  {
    key: "detail_service",
    name: "售后保障图",
    description: "质保与服务承诺",
    promptTemplate: segV27(
      `A+ 详情页售后保障模块图：宽幅横向构图，以 4 个圆形图标徽章横排呈现质保、退换货、物流、客服支持服务承诺，每项配服务标题与一行简短安心的承诺文案；{{productName}} 居中下方或一侧完整呈现呼应服务主体，顶部主标题点明服务主张。信任感版式设计、间距均匀，浅色干净背景，配色与品牌一致，信息一目了然。`,
    ),
    appliesTo: ["detail"],
    supportsCount: false,
    maxCount: 1,
    sortOrder: 32,
  },
  {
    key: "detail_steps",
    name: "使用建议图",
    description: "使用方法与技巧",
    promptTemplate: segV27(
      `A+ 详情页使用步骤模块图：宽幅横向步骤流构图，{{productName}} 的使用方法以 3~4 步横向流程呈现，每步配编号圆标、小图示与一句简短说明，箭头或连线引导阅读顺序，顶部主标题点明主题。步骤图示风格统一、间距一致，商品在首步或末步完整呈现建立整体认知，浅色干净背景，清晰直观易上手。`,
    ),
    appliesTo: ["detail"],
    supportsCount: false,
    maxCount: 1,
    sortOrder: 33,
  },
]

/** V2.4 上一代 A+ 方向模板快照（seed 守护升级判断用，仅首批 8 个 key） */
export const LEGACY_DETAIL_TEMPLATES: Record<string, string> = {
  detail_hero_banner: seg(
    `A+ 详情页首屏主视觉横幅：宽幅横向构图，{{productName}} 置于画面一侧并占据显著比例，另一侧以品牌色块或柔和渐变衬托主视觉，核心卖点「{{topSellingPoint}}」以醒目大字呈现。左右分栏版式，视觉层级分明，第一眼传递品牌调性与商品价值，画面留白克制、元素不堆砌。`,
  ),
  detail_selling_points: seg(
    `A+ 详情页核心卖点模块图：宽幅横向构图，以 3~4 个并列分栏呈现 {{productName}} 的核心卖点：{{sellingPoints}}。每栏配简洁图标、短标题与一句说明，商品实物图融入版式一侧，模块化栅格排版，信息层级清晰，配色与品牌调性统一，电商信息图风格。`,
  ),
  detail_scene: seg(
    `A+ 详情页场景演示模块图：宽幅横向构图，{{productName}} 置于典型使用环境中（目标人群：{{targetAudience}}），生活方式摄影风格，自然光或环境光氛围。商品为视觉焦点，场景道具贴合使用情境、不喧宾夺主，画面一侧留出文案区，色调真实温暖、有代入感。`,
  ),
  detail_comparison: seg(
    `A+ 详情页对比模块图：宽幅横向构图，{{productName}} 与普通方案或使用前后的差异以左右分栏呈现，对比维度配图标与简短结论，突出「{{topSellingPoint}}」带来的优势。两侧光线与背景保持一致，优势项视觉强调，差异直观易读。`,
  ),
  detail_spec: seg(
    `A+ 详情页规格参数模块图：宽幅横向构图，{{productName}} 关键参数以整齐的参数栏或图表呈现：{{sellingPoints}}。扁平化信息图风格，参数分组清晰、标签与数值对齐易读，浅色干净底色，配色与品牌调性统一。`,
  ),
  detail_steps: seg(
    `A+ 详情页使用步骤模块图：宽幅横向构图，{{productName}} 的使用方法以 3~4 步横向流程呈现，每步配编号、小图示与一句简短说明，箭头或连线引导阅读顺序，步骤图示风格统一，清晰直观易上手。`,
  ),
  detail_brand: seg(
    `A+ 详情页品牌故事横幅：宽幅横向构图，{{productName}} 与体现品牌调性的场景元素共同构成画面，电影感光影，构图克制高级，传递品牌理念与工艺传承，一侧留出品牌主张文案区，整体色调统一，画面情绪与品牌气质一致。`,
  ),
  detail_service: seg(
    `A+ 详情页售后保障模块图：宽幅横向构图，以质保、退换货、物流、客服支持等图标横排呈现服务承诺，每项配简短安心的承诺文案，信任感版式设计，配色与品牌一致，信息一目了然。`,
  ),
}
