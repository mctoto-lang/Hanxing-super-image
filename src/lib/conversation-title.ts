/**
 * 会话标题工具（供 "use server" 模块共享，故独立于 actions 文件）
 */

/** 会话标题最大长度（截取提示词时使用） */
export const CONVERSATION_TITLE_MAX = 20

/** 从提示词生成会话标题：取首行、压缩空白、截前 20 字 */
export function truncateConversationTitle(prompt: string): string {
  const firstLine = prompt.split("\n")[0] ?? ""
  const collapsed = firstLine.replace(/\s+/g, " ").trim()
  return collapsed.slice(0, CONVERSATION_TITLE_MAX)
}
