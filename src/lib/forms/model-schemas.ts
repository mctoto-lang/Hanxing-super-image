import { z } from "zod"

/**
 * 生图模型表单客户端 zod schema（model-form-dialog / preset-model-form-dialog 共用）。
 *
 * 口径（对齐 src/lib/forms/schemas.ts）：
 * - 只镜像「用户可自修复」的字段规则（必填/长度/区间/格式/枚举），供
 *   react-hook-form + standardSchemaResolver 做字段级内联校验；
 * - 镜像服务端 modelConfigSchema（src/server/schemas/admin.ts）的字段规则，
 *   但按弹窗表单形状建模：可选枚举以 "" 哨兵表示「默认/自动」，提交时再转
 *   undefined；不 import server 侧模块（其依赖 @/db/schema 会把 drizzle 拖进
 *   客户端 bundle）；
 * - apiKey 不进 schema：创建必填、编辑留空=不修改，由提交回调手动判断；
 * - 仅对特定 apiFormat 生效的字段（quality、ratioParamField）用 superRefine
 *   条件校验，避免格式切换后的残留值隐藏拦截提交（镜像原弹窗手动校验口径）。
 */

export const modelApiFormats = ["openai", "jimeng", "gemini", "grsai"] as const

/** 尺寸预设条目（结构同 @/db/schema 的 ModelSizePreset，纯 zod 自描述） */
const sizePresetSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, "比例名称不能为空")
    .max(20, "比例名称最多 20 字"),
  width: z
    .number({ message: "请输入宽度" })
    .int("宽度必须为整数")
    .min(1, "宽度至少 1px"),
  height: z
    .number({ message: "请输入高度" })
    .int("高度必须为整数")
    .min(1, "高度至少 1px"),
  enabled: z.boolean().optional(),
})

export const modelFormSchema = z
  .object({
    name: z.string().min(1, "请输入模型标识").max(100, "模型标识最多 100 字符"),
    displayName: z
      .string()
      .min(1, "请输入显示名")
      .max(200, "显示名最多 200 字符"),
    description: z.string().max(300, "描述最多 300 字"),
    badgeText: z.string().max(30, "勋章文字最多 30 字"),
    badgeColor: z.string().max(30, "勋章配色最多 30 字符"),
    apiEndpoint: z
      .string()
      .min(1, "请输入 API 地址")
      .max(500, "API 地址最多 500 字符"),
    apiFormat: z.enum(modelApiFormats),
    /** "" = 默认（不传） */
    jimengResolution: z.enum(["", "1k", "2k", "4k"]),
    jimengN: z
      .number({ message: "请输入生成数量 N" })
      .int("N 必须为整数")
      .min(1, "N 至少为 1")
      .max(8, "N 不能超过 8"),
    qualityEnabled: z.boolean(),
    quality: z.string().max(50, "质量值最多 50 字符"),
    useRatioParam: z.boolean(),
    ratioParamField: z.string(),
    /** "" = 自动（按预设尺寸推导） */
    grsaiImageSize: z.enum(["", "1K", "2K", "4K"]),
    costPerImage: z
      .number({ message: "请输入每张积分" })
      .int("每张积分必须为整数")
      .min(0, "每张积分不能为负数"),
    sizePresets: z.array(sizePresetSchema),
    supportsImageCount: z.boolean(),
    supportsSmartSize: z.boolean(),
    visibleInCreate: z.boolean(),
    visibleInWorkspace: z.boolean(),
    visibleInProduct: z.boolean(),
    visibleInWeartry: z.boolean(),
    visibleInMockup: z.boolean(),
    supportsReferenceImage: z.boolean(),
    maxReferenceImages: z
      .number({ message: "请输入最大参考图数" })
      .int("最大参考图数必须为整数")
      .min(0, "最大参考图数不能为负数")
      .max(10, "最大参考图数不能超过 10"),
    referenceImageField: z.string().max(50, "参考图字段名最多 50 字符"),
    maxConcurrent: z
      .number({ message: "请输入最大并发" })
      .int("最大并发必须为整数")
      .min(1, "最大并发至少 1")
      .max(9999, "最大并发不能超过 9999"),
    maxRetries: z
      .number({ message: "请输入最大重试" })
      .int("最大重试必须为整数")
      .min(0, "最大重试不能为负数"),
    apiTimeout: z
      .number({ message: "请输入请求超时" })
      .int("请求超时必须为整数")
      .min(1, "请求超时至少 1 秒"),
    taskTimeout: z
      .number({ message: "请输入任务总超时" })
      .int("任务总超时必须为整数")
      .min(0, "任务总超时不能为负数"),
    iconUrl: z.string().max(500, "图标 URL 最多 500 字符"),
  })
  .superRefine((d, ctx) => {
    // 质量参数仅 openai/gemini 生效：开启后必须填值（原弹窗 toast 校验的字段化）
    if (
      (d.apiFormat === "openai" || d.apiFormat === "gemini") &&
      d.qualityEnabled &&
      !d.quality.trim()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["quality"],
        message: "已开启质量参数，请填入具体质量值",
      })
    }
    // 比例字段名仅 gemini 生效：空 = 默认 aspect_ratio，非空须为合法标识符
    if (d.apiFormat === "gemini") {
      const field = d.ratioParamField
      if (field.length > 50) {
        ctx.addIssue({
          code: "custom",
          path: ["ratioParamField"],
          message: "比例字段名最多 50 字符",
        })
      } else if (field && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
        ctx.addIssue({
          code: "custom",
          path: ["ratioParamField"],
          message: "比例字段名仅限字母、数字与下划线，且不能以数字开头",
        })
      }
    }
  })

export type ModelFormValues = z.input<typeof modelFormSchema> & {
  /** 创建必填、编辑留空=不修改（不进 schema 规则，提交回调手动判断） */
  apiKey: string
}

/**
 * 从 sizePresets 的嵌套错误树中提取第一条字段错误消息。
 *
 * 编辑器的条目输入框（label/width/height）在 SizePresetsEditor 内部渲染，
 * 无法逐条目挂 FormField/FormMessage，统一在编辑器下方以一条红字兜底。
 */
export function firstSizePresetError(node: unknown): string | null {
  if (!node || typeof node !== "object") return null
  const { message, ...rest } = node as { message?: unknown }
  if (typeof message === "string" && message) return message
  for (const value of Object.values(rest)) {
    const found = firstSizePresetError(value)
    if (found) return found
  }
  return null
}
