import { z } from "zod"
import {
  MODEL_AGES,
  MODEL_BODY_TYPES,
  MODEL_GENDERS,
  MODEL_RACES,
} from "@/lib/weartry/dictionaries"

/**
 * 穿戴图片 zod schemas（四 tab：服装组图 / 模特穿戴 / AI万戴 / AI换色）
 *
 * 场景 key 为 DB 化配置（weartry_scene 表），枚举值随超管配置变化，
 * 故此处只做长度校验、由 Action 对照活跃行校验存在性。
 */

const attrValues = (defs: Array<{ value: string }>) =>
  z.enum([defs[0]!.value, ...defs.slice(1).map((d) => d.value)] as [
    string,
    ...string[],
  ])

/** 模特形象属性（AI 生成模特形象用；均可选=允许仅上传模特图直接穿戴） */
export const modelAttrInputSchema = z.object({
  gender: attrValues(MODEL_GENDERS).optional(),
  age: attrValues(MODEL_AGES).optional(),
  race: attrValues(MODEL_RACES).optional(),
  bodyType: attrValues(MODEL_BODY_TYPES).optional(),
})

// ═══════════════ 服装组图 ═══════════════

/** 选中的方向项（方向池 = product_direction.appliesTo=["weartry"]） */
export const outfitDirectionSchema = z.object({
  key: z.string().min(1).max(60),
  count: z.number().int().min(1).max(4).optional(),
})

export const generateOutfitSchema = z.object({
  modelId: z.string().uuid("请选择模型"),
  /** 服装原图（1..模型上限，Action 内二次校验） */
  referenceImages: z.array(z.string().url()).min(1, "请上传服装原图").max(10),
  /** 图片比例（"{width}x{height}"；未选时服务端兜底 1024x1024） */
  size: z.string().max(30).optional(),
  /** 服装信息合并文本块（AI 帮写编号格式，Action 内 parseProductBrief 解析出模板变量） */
  sellingPoints: z.string().max(4000).optional(),
  directions: z
    .array(outfitDirectionSchema)
    .min(1, "请至少选择 1 个方向")
    .max(20),
})

export type GenerateOutfitInput = z.infer<typeof generateOutfitSchema>

// ═══════════════ 生成模特形象（模特穿戴/AI万戴 两步流的第一步） ═══════════════

export const generateModelImageSchema = z.object({
  modelId: z.string().uuid("请选择模型"),
  size: z.string().max(30).optional(),
  attrs: modelAttrInputSchema,
  /** 模特形象补充细节 */
  details: z.string().max(1000).optional(),
})

export type GenerateModelImageInput = z.infer<typeof generateModelImageSchema>

// ═══════════════ 穿戴生图（模特穿戴 wear / AI万戴 accessory） ═══════════════

export const generateTryonSchema = z
  .object({
    mode: z.enum(["wear", "accessory"]),
    modelId: z.string().uuid("请选择模型"),
    size: z.string().max(30).optional(),
    /** 商品/配饰原图（wear 1..3、accessory 1；连同 modelImage 一并计入模型参考图上限） */
    referenceImages: z
      .array(z.string().url())
      .min(1, "请先上传原图")
      .max(3),
    /** 模特/人物形象图（AI 生成后采用，或自行上传） */
    modelImage: z.string().url("请先确定模特形象"),
    /** 预置场景（仅 wear；DB 化配置，Action 内校验存在性） */
    sceneKey: z.string().min(1).max(60).optional(),
    attrs: modelAttrInputSchema,
    details: z.string().max(1000).optional(),
    additionalPrompt: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === "wear" && data.referenceImages.length > 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["referenceImages"],
        message: "商品原图最多 3 张",
      })
    }
    if (data.mode === "accessory" && data.referenceImages.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["referenceImages"],
        message: "配饰原图仅支持 1 张",
      })
    }
  })

export type GenerateTryonInput = z.infer<typeof generateTryonSchema>

// ═══════════════ AI换色 ═══════════════

export const generateColorChangeSchema = z.object({
  modelId: z.string().uuid("请选择模型"),
  size: z.string().max(30).optional(),
  /** 待换色图片（恰 1 张） */
  referenceImage: z.string().url("请上传图片"),
  /** 换色部位（如「上衣主体」「裙摆」） */
  part: z.string().min(1, "请填写换色部位").max(50),
  colorName: z.string().min(1, "请选择颜色").max(30),
  colorHex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "颜色 HEX 值不合法"),
  /** HSB（h 0-360，s/b 0-100 的紧凑串，如 "231,55,27"） */
  colorHsb: z.string().min(1).max(30),
  colorRgb: z.string().min(1).max(30),
  additionalPrompt: z.string().max(2000).optional(),
})

export type GenerateColorChangeInput = z.infer<typeof generateColorChangeSchema>

// ═══════════════ AI 帮写（服装组图） ═══════════════

export const weartryAiAssistSchema = z.object({
  referenceImages: z.array(z.string().url()).min(1, "请先上传服装原图").max(10),
  userNotes: z.string().max(1000).optional(),
})

export type WeartryAiAssistInput = z.infer<typeof weartryAiAssistSchema>
