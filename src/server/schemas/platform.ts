import { z } from "zod"
import { MODULE_NAMES } from "@/db/schema"
import { BANNER_ICON_NAMES } from "@/lib/banner"
import { BADGE_ICON_KEYS } from "@/lib/plans/badge"

/**
 * 平台管理 zod schemas（手册 M2）
 */

const slugRegex = /^[a-z0-9-]+$/

export const createEnterpriseSchema = z.object({
  name: z.string().min(2, "企业名称至少 2 字符").max(100),
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(slugRegex, "slug 只能含小写字母、数字、短横线"),
  enabledModules: z.array(z.enum(MODULE_NAMES)).optional(),
  maxConcurrent: z.number().int().min(1).max(100).optional(),
  chatMaxConcurrent: z.number().int().min(1).max(100).optional(),
  initialCredits: z.number().int().min(0).optional(),
  allowCustomModels: z.boolean().optional(),
  visiblePresetModels: z.array(z.string().uuid()).optional(),
  visiblePresetChatModels: z.array(z.string().uuid()).optional(),
  owner: z
    .object({
      username: z.string().min(2).max(50),
      password: z.string().min(6, "密码至少 6 字符").max(128),
      name: z.string().max(100).optional(),
    })
    .optional(),
})

export const createUserSchema = z.object({
  username: z
    .string()
    .min(2, "用户名至少 2 字符")
    .max(50)
    .regex(/^[a-zA-Z0-9_-]+$/, "用户名只能含字母、数字、下划线、短横线"),
  password: z.string().min(6, "密码至少 6 字符").max(128),
  name: z.string().max(100).optional(),
  email: z.string().email("邮箱格式错误").optional().or(z.literal("")),
  enterpriseId: z.string().uuid("请选择企业"),
  role: z.enum(["owner", "admin", "member"]).optional(),
  groupId: z.string().uuid().optional(),
})

export const rechargeSchema = z.object({
  enterpriseId: z.string().uuid("请选择企业"),
  amount: z
    .number()
    .int("充值数量必须为整数")
    .min(1, "充值数量至少 1")
    .max(1_000_000, "单次充值上限 100 万"),
  remark: z.string().max(200).optional(),
})

export const updateModulesSchema = z.object({
  enterpriseId: z.string().uuid("请选择企业"),
  modules: z.array(z.enum(MODULE_NAMES)),
})

/** 企业级并发配置（生图 + 对话，企业管理页设置） */
export const updateEnterpriseConcurrencySchema = z.object({
  enterpriseId: z.string().uuid("请选择企业"),
  maxConcurrent: z
    .number()
    .int("生图并发必须为整数")
    .min(1, "生图并发至少 1")
    .max(100, "生图并发不能超过 100"),
  chatMaxConcurrent: z
    .number()
    .int("对话并发必须为整数")
    .min(1, "对话并发至少 1")
    .max(100, "对话并发不能超过 100"),
})

/** 企业级模型配置（需求 2b）：是否允许自建私有模型 + 可见平台预置模型白名单 */
export const updateEnterpriseModelConfigSchema = z.object({
  enterpriseId: z.string().uuid("请选择企业"),
  allowCustomModels: z.boolean(),
  /** 空 = 全部预置模型可见 */
  visiblePresetModels: z.array(z.string().uuid()),
  /** 空 = 全部预置对话模型可见 */
  visiblePresetChatModels: z.array(z.string().uuid()),
})

/** ISO 时间字符串（客户端 datetime-local → toISOString 后传入） */
const isoTimestamp = z
  .string()
  .min(1)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), "时间格式错误")

/** 广告横幅新建/编辑入参（时间均为 ISO 字符串，空 = 不限） */
export const bannerInputSchema = z
  .object({
    title: z.string().min(1, "标题不能为空").max(100, "标题最多 100 字"),
    content: z.string().min(1, "内容不能为空").max(300, "内容最多 300 字"),
    linkUrl: z
      .string()
      .trim()
      .max(500, "链接最多 500 字符")
      .refine(
        (v) => v === "" || /^https?:\/\//i.test(v),
        "链接必须以 http:// 或 https:// 开头",
      )
      .optional(),
    linkLabel: z.string().trim().min(1, "按钮文字不能为空").max(50).optional(),
    icon: z.enum(BANNER_ICON_NAMES).optional(),
    countdownEndsAt: isoTimestamp.optional(),
    startsAt: isoTimestamp.optional(),
    endsAt: isoTimestamp.optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .superRefine((d, ctx) => {
    if (d.startsAt && d.endsAt && new Date(d.endsAt) <= new Date(d.startsAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "投放结束时间必须晚于开始时间",
      })
    }
  })

export const updateBannerSchema = bannerInputSchema.extend({
  id: z.string().uuid("缺少横幅 ID"),
})

export const deleteBannerSchema = z.object({
  id: z.string().uuid("缺少横幅 ID"),
})

export const toggleBannerSchema = z.object({
  id: z.string().uuid("缺少横幅 ID"),
  isActive: z.boolean(),
})

/** 订阅套餐新建/编辑入参（勋章 = 预设图标 key + #RRGGBB 颜色） */
export const subscriptionPlanInputSchema = z.object({
  name: z.string().trim().min(1, "套餐名称不能为空").max(50, "套餐名称最多 50 字符"),
  iconKey: z.enum(BADGE_ICON_KEYS, { message: "请选择预设勋章图标" }),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "颜色格式为 #RRGGBB"),
  creditsPerCycle: z
    .number()
    .int("周期积分必须为整数")
    .min(1, "周期积分至少 1")
    .max(1_000_000, "周期积分上限 100 万"),
  cycleDays: z
    .number()
    .int("周期天数必须为整数")
    .min(1, "周期至少 1 天")
    .max(3650, "周期最长 10 年"),
  maxMembers: z
    .number()
    .int("人数上限必须为整数")
    .min(1, "人数上限至少 1")
    .max(10_000)
    .nullable()
    .optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
})

export const updateSubscriptionPlanSchema = subscriptionPlanInputSchema.extend({
  id: z.string().uuid("缺少套餐 ID"),
})

export const toggleSubscriptionPlanSchema = z.object({
  id: z.string().uuid("缺少套餐 ID"),
  isActive: z.boolean(),
})

/** 给企业分配套餐（分配即发放首期到企业积分池） */
export const assignEnterprisePlanSchema = z
  .object({
    enterpriseId: z.string().uuid("请选择企业"),
    planId: z.string().uuid("请选择套餐"),
    expiresAt: isoTimestamp,
  })
  .superRefine((d, ctx) => {
    if (new Date(d.expiresAt).getTime() <= Date.now()) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "到期时间必须晚于当前时间",
      })
    }
  })

/** 套餐续期（仅延长到期时间） */
export const renewEnterprisePlanSchema = z.object({
  enterpriseId: z.string().uuid("请选择企业"),
  expiresAt: isoTimestamp,
})

export const clearEnterprisePlanSchema = z.object({
  enterpriseId: z.string().uuid("请选择企业"),
})
