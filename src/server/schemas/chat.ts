import { z } from "zod"

/**
 * AI 对话 Server Actions / 流式路由的 zod 校验（手册 §5.2）
 */

/** 思考强度档位 */
export const thinkingLevelSchema = z.enum(["off", "low", "medium", "high"])

/** 发送消息（流式路由请求体） */
export const sendChatMessageSchema = z.object({
  /** 所属会话；未传 = 新会话（首条消息后自动创建） */
  conversationId: z.string().uuid().nullish(),
  modelId: z.string().uuid(),
  content: z
    .string()
    .trim()
    .min(1, "消息内容不能为空")
    .max(20000, "消息内容过长（上限 20000 字符）"),
  thinkingLevel: thinkingLevelSchema.default("off"),
  /** 重新生成：复用会话内最后一条用户消息，不新插入 user 消息 */
  regenerate: z.boolean().default(false),
})

/** 会话重命名 */
export const renameChatConversationSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1, "标题不能为空").max(200, "标题过长"),
})
