import { z } from "zod"

/**
 * 配置类表单弹窗客户端 zod schemas（client-safe，超管配置中心统一设计语言）。
 *
 * 口径（与 schemas.ts 一致）：
 * - 只镜像「用户可自修复」的字段规则（必填/长度/区间/格式/枚举），供
 *   react-hook-form + standardSchemaResolver 做字段级内联校验；
 * - 服务端 schema（src/server/schemas/platform.ts、platform-product.ts、
 *   platform-weartry.ts）仍是权威——本文件不 import server 侧模块与
 *   @/db/schema（会把 drizzle 拖进客户端 bundle），枚举值以字面量内联镜像；
 * - 场景（prompt-template 的 scene）按端（product/weartry/mockup）清单不同，
 *   客户端只做必填形状校验，严格枚举由服务端兜底。
 */

const keySlugRegex = /^[a-z0-9_]+$/

/** 图片方向（direction-form-dialog；scope 枚举镜像 PRODUCT_DIRECTION_SCOPES） */
export const directionFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "请输入方向名称")
    .max(100, "方向名称最多 100 字"),
  description: z.string().max(200, "描述最多 200 字").optional(),
  promptTemplate: z
    .string()
    .trim()
    .min(1, "请输入提示词模板")
    .max(5000, "提示词模板最多 5000 字"),
  scope: z.enum(["suite", "detail", "refine", "weartry"]),
  supportsCount: z.boolean(),
  maxCount: z
    .number({ message: "请输入数量上限" })
    .int("数量上限必须为整数")
    .min(1, "数量上限至少 1")
    .max(4, "数量上限不能超过 4"),
  isHidden: z.boolean(),
  isHero: z.boolean(),
})

/** 穿戴场景（scene-form-dialog） */
export const sceneFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "请输入场景名称")
    .max(100, "场景名称最多 100 字"),
  description: z.string().max(200, "描述最多 200 字").optional(),
  promptTemplate: z
    .string()
    .trim()
    .min(1, "请填写提示词模板")
    .max(4000, "提示词模板最多 4000 字"),
})

/** 平台尺寸规范（size-spec-form-dialog；appliesTo 枚举镜像 PRODUCT_SIZE_SPEC_SCOPES） */
export const sizeSpecFormSchema = z.object({
  platformKey: z
    .string()
    .trim()
    .min(1, "请选择平台")
    .max(30, "平台标识最多 30 字"),
  label: z
    .string()
    .trim()
    .min(1, "请输入尺寸名称")
    .max(100, "尺寸名称最多 100 字"),
  width: z
    .number({ message: "请输入宽度" })
    .int("宽度必须为整数")
    .min(64, "宽度至少 64px")
    .max(8192, "宽度不能超过 8192px"),
  height: z
    .number({ message: "请输入高度" })
    .int("高度必须为整数")
    .min(64, "高度至少 64px")
    .max(8192, "高度不能超过 8192px"),
  ratioLabel: z.string().max(30, "比例文案最多 30 字").optional(),
  note: z.string().max(500, "规范说明最多 500 字").optional(),
  appliesTo: z
    .array(z.enum(["suite", "detail"]))
    .min(1, "请至少选择一个适用子功能"),
})

/** 上架平台（platform-config-dialogs；key 仅新建时可编辑） */
export const platformConfigFormSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, "请输入平台标识")
    .max(30, "平台标识最多 30 字")
    .regex(keySlugRegex, "标识仅限小写字母、数字与下划线"),
  label: z
    .string()
    .trim()
    .min(1, "请输入平台名称")
    .max(100, "平台名称最多 100 字"),
  heroPromptSegment: z
    .string()
    .max(2000, "主图规范提示词最多 2000 字")
    .optional(),
  generalPromptSegment: z
    .string()
    .max(2000, "通用平台偏好提示词最多 2000 字")
    .optional(),
})

/** 生图语言（language-config-dialogs；key 仅新建时可编辑） */
export const languageConfigFormSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, "请输入语言标识")
    .max(20, "语言标识最长 20 字")
    .regex(keySlugRegex, "标识仅限小写字母、数字与下划线"),
  label: z
    .string()
    .trim()
    .min(1, "请输入显示名称")
    .max(100, "显示名称最多 100 字"),
  outputName: z
    .string()
    .trim()
    .min(1, "请输入输出语言名")
    .max(100, "输出语言名最多 100 字"),
  imageDirective: z.string().max(1000, "图内文字指令最多 1000 字").optional(),
})

/** 提示词模板（prompt-template-config-dialogs；scene 按端清单不同，客户端只做必填） */
export const promptTemplateFormSchema = z.object({
  scene: z.string().min(1, "请选择场景"),
  name: z
    .string()
    .trim()
    .min(1, "请输入模板名称")
    .max(100, "模板名称最多 100 字"),
  template: z
    .string()
    .trim()
    .min(1, "请输入提示词模板")
    .max(8000, "提示词模板最多 8000 字"),
  note: z.string().max(1000, "变量说明最多 1000 字").optional(),
})

/** 样机渲染服务配置（mockup-config-dialog；URL 格式与启用前提由服务端兜底） */
export const mockupSettingFormSchema = z.object({
  apiBaseUrl: z
    .string()
    .trim()
    .max(500, "服务地址最多 500 字")
    .refine(
      (v) => v === "" || /^https?:\/\/.+/i.test(v),
      "服务地址必须是 http(s):// 开头的 URL",
    ),
  /** 留空 = 保留已存密钥（服务端按 hasApiKey 掩码判断） */
  apiKey: z.string().optional(),
  /** 留空 = 保留；输入 - = 清除（服务端语义） */
  webhookSecret: z.string().optional(),
  costPerRender: z
    .number({ message: "请输入渲染单价" })
    .int("渲染单价必须为整数")
    .min(1, "渲染单价至少 1")
    .max(100000, "渲染单价不能超过 100000"),
  enabled: z.boolean(),
})

/** TEMU 应用配置（temu-app-manage-dialog；appSecret 掩码回显原样提交=保留现值） */
export const temuAppSettingFormSchema = z
  .object({
    name: z.string().trim().min(1, "请填写应用名称").max(100, "应用名称最多 100 字"),
    appKey: z.string().trim().max(100, "app_key 最多 100 字"),
    appSecret: z.string().max(200, "app_secret 最多 200 字"),
    testMode: z.boolean(),
  })
  .superRefine((d, ctx) => {
    if (!d.testMode && d.appKey && !d.appSecret) {
      ctx.addIssue({
        code: "custom",
        path: ["appSecret"],
        message: "已填写 app_key 但 app_secret 为空，请补全后再保存",
      })
    }
    if (!d.testMode && !d.appKey && d.appSecret) {
      ctx.addIssue({
        code: "custom",
        path: ["appKey"],
        message: "已填写 app_secret 但 app_key 为空，请补全后再保存",
      })
    }
  })

/** 权限组成员整组转移（group-members-dialog） */
export const groupMembersFormSchema = z.object({
  toGroupId: z.string().min(1, "请选择目标权限组"),
})
