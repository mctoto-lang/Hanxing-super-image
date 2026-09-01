import { z } from "zod"
import { PRODUCT_MODES } from "@/lib/product/dictionaries"

/**
 * 商品主图 V2 zod schemas（四 tab：商品套图 / A+详情页 / 爆款复刻 / 产品精修）
 *
 * platform/language 为 DB 化配置（product_platform/product_language 表），
 * 枚举值随超管配置变化，故此处只做长度校验、由 Action 对照活跃行校验存在性。
 */

/** 智能匹配注入的方向定制变量（可选，缺失时模板对应句自然省略） */
const directionVarsSchema = z.object({
  angle: z.string().max(200).optional(),
  focus: z.string().max(200).optional(),
  copyHint: z.string().max(200).optional(),
  target: z.string().max(200).optional(),
})

/** 选中的方向项 */
export const directionSelectionSchema = z.object({
  key: z.string().min(1).max(60),
  count: z.number().int().min(1).max(4).optional(),
  vars: directionVarsSchema.optional(),
})

/** 套图卡片提交项（卡片确认阶段的产物） */
export const suiteCardSubmitSchema = z.object({
  /** 须为活跃套图方向池内的 key（含前端隐藏方向） */
  directionKey: z.string().min(1).max(60),
  directionName: z.string().min(1).max(100),
  /** 用户确认后的画面提示词（服务端拼装平台/语言段后生图） */
  prompt: z.string().min(1, "卡片提示词不能为空").max(4000),
})

export const generateProductV2Schema = z
  .object({
    mode: z.enum(PRODUCT_MODES),
    modelId: z.string().uuid("请选择模型"),
    /** 商品原图（refine 恰 1 张；其余 1..模型上限，Action 内二次校验） */
    referenceImages: z.array(z.string().url()).min(1, "请上传商品原图"),
    /** 爆款参考图（replicate 必填，不计入模型参考图上限的单独字段） */
    benchmarkImage: z.string().url().optional(),
    platform: z.string().min(1).max(30).optional(),
    language: z.string().min(1).max(20).optional(),
    /** 图片比例（"{width}x{height}"；suite/replicate/refine 用，detail 走 sizeSpecId） */
    size: z.string().max(30).optional(),
    /** A+ 规范尺寸 id（detail 用；传了则覆盖 size） */
    sizeSpecId: z.string().uuid().optional(),
    /** 商品信息合并文本块（编号格式，Action 内 parseProductBrief 解析出模板变量） */
    sellingPoints: z.string().max(4000).optional(),
    /** 补充要求（复刻/精修的额外提示词） */
    additionalPrompt: z.string().max(2000).optional(),
    /** 方向选择（suite 旧路径/detail/refine） */
    directions: z.array(directionSelectionSchema).max(20).optional(),
    /** 套图卡片（卡片确认阶段提交；suite 时优先于 directions） */
    cards: z.array(suiteCardSubmitSchema).max(20).optional(),
    /** 复刻程度（replicate 必填） */
    replicateLevel: z.enum(["style", "strict"]).optional(),
  })
  .superRefine((data, ctx) => {
    const add = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message })

    if (data.mode === "refine") {
      if (data.referenceImages.length !== 1) add("referenceImages", "产品精修仅支持 1 张原图")
      if (!data.directions || data.directions.length === 0)
        add("directions", "请至少选择 1 个优化项")
    }
    if (data.mode === "replicate") {
      if (!data.benchmarkImage) add("benchmarkImage", "请上传爆款参考图")
      if (!data.replicateLevel) add("replicateLevel", "请选择复刻程度")
      if (!data.platform) add("platform", "请选择上架平台")
      if (!data.language) add("language", "请选择语言")
    }
    if (data.mode === "suite" || data.mode === "detail") {
      if (!data.platform) add("platform", "请选择上架平台")
      if (!data.language) add("language", "请选择语言")
      if (!data.sellingPoints || data.sellingPoints.trim().length === 0)
        add("sellingPoints", "请填写商品信息")
      if (data.mode === "detail" && (!data.directions || data.directions.length === 0))
        add("directions", "请至少选择 1 个方向")
      if (data.mode === "suite" && !data.cards?.length && (!data.directions || data.directions.length === 0))
        add("directions", "请至少选择 1 个方向")
      if (data.mode === "detail" && !data.sizeSpecId)
        add("sizeSpecId", "A+详情页请选择平台规范尺寸")
      if (data.mode === "suite" && !data.sizeSpecId && !data.size)
        add("size", "请选择图片比例")
    }
  })

export type GenerateProductV2Input = z.infer<typeof generateProductV2Schema>
export type DirectionSelection = z.infer<typeof directionSelectionSchema>

/** AI 帮写（套图/详情页共用，按 mode 取提示词模板） */
export const aiAssistSchema = z.object({
  mode: z.enum(["suite", "detail"]),
  referenceImages: z.array(z.string().url()).min(1, "请先上传商品原图"),
  platform: z.string().min(1).max(30),
  language: z.string().min(1).max(20),
  userNotes: z.string().max(1000).optional(),
})

export type AiAssistInput = z.infer<typeof aiAssistSchema>

/** 智能匹配（仅套图 tab） */
export const smartMatchSchema = z.object({
  referenceImages: z.array(z.string().url()).min(1, "请先上传商品原图"),
  platform: z.string().min(1).max(30),
  language: z.string().min(1).max(20),
  sellingPoints: z.string().min(1, "请先填写商品信息").max(4000),
  productName: z.string().max(200).optional(),
})

export type SmartMatchInput = z.infer<typeof smartMatchSchema>

// ═══════════════ 套图卡片提示词生成（卡片确认阶段） ═══════════════

/** 出卡入参中的单个方向（vars 为智能匹配定制，可选） */
const cardInputSchema = z.object({
  directionKey: z.string().min(1).max(60),
  directionName: z.string().max(100).optional(),
  vars: directionVarsSchema.optional(),
})

/** 批量出卡（一次对话调用生成全部卡片提示词；计 1 次 AI 限流） */
export const generateSuiteCardsSchema = z.object({
  platform: z.string().min(1).max(30),
  language: z.string().min(1).max(20),
  referenceImages: z.array(z.string().url()).min(1, "请先上传商品原图").max(10),
  /** 商品信息合并文本块（含卖点与要求） */
  sellingPoints: z.string().min(1, "请先填写商品信息").max(4000),
  cards: z.array(cardInputSchema).min(1, "卡片列表为空").max(20),
})

export type GenerateSuiteCardsInput = z.infer<typeof generateSuiteCardsSchema>

/** 单卡重新生成（计 1 次 AI 限流） */
export const regenerateSuiteCardSchema = z.object({
  platform: z.string().min(1).max(30),
  language: z.string().min(1).max(20),
  referenceImages: z.array(z.string().url()).min(1).max(10),
  sellingPoints: z.string().min(1).max(4000),
  card: cardInputSchema,
})

export type RegenerateSuiteCardInput = z.infer<typeof regenerateSuiteCardSchema>
