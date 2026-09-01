import { z } from "zod"

/**
 * 创作会话 zod schemas（自由创作页 §6 重新设计）
 */

export const renameConversationSchema = z.object({
  id: z.string().uuid(),
  title: z
    .string()
    .min(1, "标题不能为空")
    .max(60, "标题过长（上限 60 字符）")
    .trim(),
})

export const listConversationTasksSchema = z.object({
  conversationId: z.string().uuid(),
})

export const deleteTaskSchema = z.object({
  taskId: z.string().uuid(),
})

export type RenameConversationInput = z.infer<typeof renameConversationSchema>
