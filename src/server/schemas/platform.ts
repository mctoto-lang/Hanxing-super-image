import { z } from "zod"
import { MODULE_NAMES } from "@/db/schema"

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
  initialCredits: z.number().int().min(0).optional(),
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
