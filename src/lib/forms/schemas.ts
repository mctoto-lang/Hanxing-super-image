import { z } from "zod"
import { BANNER_ICON_NAMES } from "@/lib/banner"
import { BADGE_ICON_KEYS } from "@/lib/plans/badge"

/**
 * 管理端弹窗客户端 zod schemas（client-safe，企业管理双侧统一设计语言）。
 *
 * 口径：
 * - 只镜像「用户可自修复」的字段规则（必填/长度/区间/格式/枚举），供
 *   react-hook-form + standardSchemaResolver 做字段级内联校验；
 * - 服务端 schema（src/server/schemas/*）仍是权威——本文件不 import
 *   server 侧模块（其依赖 @/db/schema 会把 drizzle 拖进客户端 bundle），
 *   枚举值取自 @/lib/banner、@/lib/plans/badge 等已标注客户端共用的纯数据源；
 * - 模块/模型 ID 数组等宽松字段客户端只做形状校验，严格枚举由服务端兜底。
 */

const slugRegex = /^[a-z0-9-]+$/
const usernameRegex = /^[a-zA-Z0-9_-]+$/

/** 企业充值（recharge-dialog） */
export const rechargeFormSchema = z.object({
  amount: z.number({ message: "请输入充值数量" })
    .int("充值数量必须为整数")
    .min(1, "充值数量至少 1")
    .max(1_000_000, "单次充值上限 100 万"),
  remark: z.string().max(200, "备注最多 200 字").optional(),
})

/** 添加成员（member-create / enterprise-member-create） */
export const memberCreateFormSchema = z.object({
  username: z
    .string()
    .min(2, "用户名至少 2 字符")
    .max(50, "用户名最多 50 字符")
    .regex(usernameRegex, "用户名只能含字母、数字、下划线、短横线"),
  password: z.string().min(6, "密码至少 6 字符").max(128, "密码最多 128 字符"),
  name: z.string().max(100, "昵称最多 100 字").optional(),
  email: z.string().email("邮箱格式错误").optional().or(z.literal("")),
  role: z.enum(["member", "admin", "owner"]),
  groupId: z.string().optional(),
})

/** 重置成员密码（reset-password-dialog；confirm 一致性由 refine 校验） */
export const resetPasswordFormSchema = z
  .object({
    newPassword: z.string().min(6, "密码至少 6 字符").max(128, "密码最多 128 字符"),
    confirm: z.string(),
  })
  .refine((d) => d.newPassword === d.confirm, {
    path: ["confirm"],
    message: "两次输入的密码不一致",
  })

/** 分配积分（allocate-credits-dialog） */
export const allocateCreditsFormSchema = z.object({
  amount: z.number({ message: "请输入分配数量" })
    .int("分配数量必须为整数")
    .min(1, "分配数量必须为正整数")
    .max(1_000_000, "单次分配上限 100 万"),
  remark: z.string().max(200, "备注最多 200 字").optional(),
})

/** 调整个人配额（credits-adjust-dialog） */
export const adjustCreditsFormSchema = z.object({
  newBalance: z.number({ message: "请输入新余额" })
    .int("新余额必须为整数")
    .min(0, "新余额必须是不小于 0 的整数")
    .max(100_000_000, "新余额超出上限"),
  remark: z.string().max(200, "备注最多 200 字").optional(),
})

/** 权限组新建/编辑（group-create / group-edit；页面/模型勾选集只做形状校验） */
export const permissionGroupFormSchema = z.object({
  name: z.string().min(2, "组名至少 2 字符").max(100, "组名最多 100 字符"),
  description: z.string().max(500, "描述最多 500 字").optional(),
  maxConcurrent: z.number({ message: "请输入并发上限" })
    .int("并发上限必须为整数")
    .min(1, "并发上限至少 1")
    .max(9999, "并发上限不能超过 9999"),
  priority: z.number({ message: "请输入优先级" })
    .int("优先级必须为整数")
    .min(0, "优先级最小 0")
    .max(100, "优先级最大 100"),
})

/** 创建企业（enterprise-create-dialog；owner 组可选） */
export const enterpriseCreateFormSchema = z.object({
  name: z.string().min(2, "企业名称至少 2 字符").max(100, "企业名称最多 100 字符"),
  slug: z
    .string()
    .min(2, "slug 至少 2 字符")
    .max(50, "slug 最多 50 字符")
    .regex(slugRegex, "slug 只能含小写字母、数字、短横线"),
  initialCredits: z
    .number({ message: "请输入初始积分" })
    .int("初始积分必须为整数")
    .min(0, "初始积分不能为负")
    .max(1_000_000_000, "初始积分超出上限"),
  maxConcurrent: z
    .number({ message: "请输入生图并发" })
    .int()
    .min(1, "生图并发至少 1")
    .max(9999, "生图并发不能超过 9999"),
  chatMaxConcurrent: z
    .number({ message: "请输入对话并发" })
    .int()
    .min(1, "对话并发至少 1")
    .max(9999, "对话并发不能超过 9999"),
  ownerUsername: z
    .string()
    .max(50, "用户名最多 50 字符")
    .regex(usernameRegex, "用户名只能含字母、数字、下划线、短横线")
    .optional(),
  ownerPassword: z.string().max(128).optional(),
  ownerName: z.string().max(100).optional(),
})

/** 企业并发（enterprise-concurrency-dialog） */
export const enterpriseConcurrencyFormSchema = z.object({
  maxConcurrent: z.number({ message: "请输入生图并发" })
    .int("生图并发必须为整数")
    .min(1, "生图并发至少 1")
    .max(9999, "生图并发不能超过 9999"),
  chatMaxConcurrent: z.number({ message: "请输入对话并发" })
    .int("对话并发必须为整数")
    .min(1, "对话并发至少 1")
    .max(9999, "对话并发不能超过 9999"),
})

/** 超管建用户（user-create-dialog） */
export const userCreateFormSchema = z.object({
  username: z
    .string()
    .min(2, "用户名至少 2 字符")
    .max(50, "用户名最多 50 字符")
    .regex(usernameRegex, "用户名只能含字母、数字、下划线、短横线"),
  password: z.string().min(6, "密码至少 6 字符").max(128, "密码最多 128 字符"),
  name: z.string().max(100, "昵称最多 100 字").optional(),
  email: z.string().email("邮箱格式错误").optional().or(z.literal("")),
  enterpriseId: z.string().min(1, "请选择企业"),
  role: z.enum(["owner", "admin", "member"]),
  groupId: z.string().optional(),
})

/** 超管编辑平台用户（user-edit-dialog；类型=超管时企业/角色联动禁用并清空） */
export const userEditFormSchema = z
  .object({
    username: z
      .string()
      .min(2, "用户名至少 2 字符")
      .max(50, "用户名最多 50 字符")
      .regex(usernameRegex, "用户名只能含字母、数字、下划线、短横线"),
    name: z.string().max(100, "昵称最多 100 字").optional(),
    isSuperAdmin: z.boolean(),
    /** 空串 = 无企业（仅超管合法） */
    enterpriseId: z.string(),
    role: z.enum(["owner", "admin", "member"]),
  })
  .refine((d) => d.isSuperAdmin || d.enterpriseId !== "", {
    message: "请选择归属企业",
    path: ["enterpriseId"],
  })

/** 企业信息编辑（enterprise-edit-dialog） */
export const enterpriseInfoFormSchema = z.object({
  name: z.string().min(2, "企业名称至少 2 字符").max(100, "企业名称最多 100 字符"),
  slug: z
    .string()
    .min(2, "slug 至少 2 字符")
    .max(50, "slug 最多 50 字符")
    .regex(slugRegex, "slug 只能含小写字母、数字、短横线"),
  logoUrl: z.string().max(500).nullable().optional(),
})

/** 套餐表单（plan-form-dialog；色板/hex 联动由 Controller 自定义组件呈现） */
export const planFormSchema = z.object({
  name: z.string().trim().min(1, "套餐名称不能为空").max(50, "套餐名称最多 50 字"),
  iconKey: z.enum(BADGE_ICON_KEYS),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "颜色格式为 #RRGGBB"),
  creditsPerCycle: z.number({ message: "请输入周期积分" })
    .int("周期积分必须为整数")
    .min(1, "周期积分至少 1")
    .max(1_000_000, "周期积分上限 100 万"),
  cycleDays: z.number({ message: "请输入周期天数" })
    .int("周期天数必须为整数")
    .min(1, "周期至少 1 天")
    .max(3650, "周期最长 10 年"),
  maxMembers: z
    .union([z.number().int().min(1, "人数上限至少 1").max(10_000), z.literal(""), z.null()])
    .transform((v) => (v === "" || v === null ? null : v))
    .optional(),
  isActive: z.boolean(),
})

/** 分配套餐（plan-assign-dialog） */
export const planAssignFormSchema = z.object({
  planId: z.string().min(1, "请选择套餐"),
  expiresAt: z.string().min(1, "请选择到期时间"),
})

/** 广告横幅（banner-form-dialog） */
export const bannerFormSchema = z
  .object({
    title: z.string().min(1, "标题不能为空").max(100, "标题最多 100 字"),
    content: z.string().min(1, "内容不能为空").max(300, "内容最多 300 字"),
    linkUrl: z
      .string()
      .trim()
      .max(500, "链接最多 500 字符")
      .refine((v) => v === "" || /^https?:\/\//i.test(v), "链接必须以 http:// 或 https:// 开头")
      .optional(),
    linkLabel: z.string().trim().min(1, "按钮文字不能为空").max(50, "按钮文字最多 50 字").optional(),
    icon: z.enum(BANNER_ICON_NAMES).optional(),
    countdownEndsAt: z.string().optional(),
    startsAt: z.string().optional(),
    endsAt: z.string().optional(),
    isActive: z.boolean(),
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

/** 成员编辑（member-edit-dialog；name/email 进 RHF，avatar/role/group 为受控 state 不进表单） */
export const memberEditFormSchema = z.object({
  name: z.string().max(100).optional(),
  email: z.string().email("邮箱格式错误").optional().or(z.literal("")),
})
