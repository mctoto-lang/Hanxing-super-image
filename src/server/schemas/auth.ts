import { z } from "zod"

/**
 * 认证相关 zod schema（手册 §10.1：前后端共享）
 */

export const loginSchema = z.object({
  username: z
    .string()
    .min(2, "用户名至少 2 字符")
    .max(50, "用户名至多 50 字符"),
  password: z
    .string()
    .min(1, "请输入密码")
    .max(128, "密码至多 128 字符"),
})

export type LoginInput = z.infer<typeof loginSchema>
