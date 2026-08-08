import { z } from "zod"

export const updateProfileSchema = z.object({
  name: z.string().max(100, "昵称过长").optional(),
  email: z
    .string()
    .email("邮箱格式错误")
    .optional()
    .or(z.literal("")),
})

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "请输入当前密码"),
    newPassword: z
      .string()
      .min(6, "新密码至少 6 字符")
      .max(128, "密码过长"),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "两次输入的新密码不一致",
    path: ["confirmPassword"],
  })
