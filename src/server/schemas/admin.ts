import { z } from "zod"
import { MODULE_NAMES } from "@/db/schema"

/**
 * 企业管理员 zod schemas（手册 M2）
 */

export const createMemberSchema = z.object({
  username: z
    .string()
    .min(2, "用户名至少 2 字符")
    .max(50)
    .regex(/^[a-zA-Z0-9_-]+$/, "用户名只能含字母、数字、下划线、短横线"),
  password: z.string().min(6, "密码至少 6 字符").max(128),
  name: z.string().max(100).optional(),
  email: z.string().email("邮箱格式错误").optional().or(z.literal("")),
  role: z.enum(["owner", "admin", "member"]).optional(),
  groupId: z.string().uuid().optional(),
})

export const changeRoleSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["owner", "admin", "member"]),
})

export const assignGroupSchema = z.object({
  userId: z.string().uuid(),
  groupId: z.string().uuid(),
})

export const permissionGroupSchema = z.object({
  name: z.string().min(2, "组名至少 2 字符").max(100),
  description: z.string().max(500).optional(),
  allowedModels: z.array(z.string().uuid()).default([]),
  allowedPages: z.array(z.enum(MODULE_NAMES)).default([]),
  maxConcurrent: z.number().int().min(1).max(100).default(2),
  priority: z.number().int().min(0).max(100).default(0),
})
