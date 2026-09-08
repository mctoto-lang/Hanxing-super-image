import { z } from "zod"

/**
 * AI 对话 Server Actions / 流式路由的 zod 校验（手册 §5.2）
 */

/** 思考强度档位（关闭 + 滑杆六档） */
export const thinkingLevelSchema = z.enum([
  "off",
  "low",
  "medium",
  "high",
  "extra",
  "max",
  "ultracode",
])

/**
 * 图片 URL 防护：仅允许本系统存储（COS canonical 域或应用自身域名）。
 * 历史消息会随上下文回传（gemini 适配器还会服务端取图），不能放开任意外链。
 */
function isAllowedChatImageUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== "https:" && url.protocol !== "http:") return false
    const host = url.hostname.toLowerCase()
    if (host.endsWith(".myqcloud.com")) return true
    const appUrl = process.env.NEXT_PUBLIC_APP_URL
    if (appUrl) {
      try {
        if (new URL(appUrl).hostname.toLowerCase() === host) return true
      } catch {
        // 应用域名未配置/非法时忽略
      }
    }
    return false
  } catch {
    return false
  }
}

/** 发送消息（流式路由请求体） */
export const sendChatMessageSchema = z
  .object({
    /** 所属会话；未传 = 新会话（首条消息后自动创建） */
    conversationId: z.string().uuid().nullish(),
    modelId: z.string().uuid(),
    /** 纯文本部分；允许为空（纯图消息），但需与 images 至少有一项 */
    content: z
      .string()
      .trim()
      .max(20000, "消息内容过长（上限 20000 字符）")
      .default(""),
    /** 附件图片 URL（多模态；须为本系统上传返回的存储 URL） */
    images: z
      .array(z.string().url("图片地址格式错误"))
      .max(4, "单条消息最多 4 张图片")
      .refine((urls) => urls.every(isAllowedChatImageUrl), {
        message: "仅支持本系统上传的图片",
      })
      .default([]),
    thinkingLevel: thinkingLevelSchema.default("off"),
    /** 重新生成：复用会话内最后一条用户消息，不新插入 user 消息 */
    regenerate: z.boolean().default(false),
  })
  .refine((d) => d.content.length > 0 || d.images.length > 0, {
    message: "消息内容不能为空",
    path: ["content"],
  })

/** 会话重命名 */
export const renameChatConversationSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1, "标题不能为空").max(200, "标题过长"),
})
