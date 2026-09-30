/**
 * Agent 域业务性 404：项目不存在 / 无权访问 / 类型不符。
 * 页面据此走 notFound()；其余异常原样上抛交给 error 边界呈现（避免把
 * DB/基础设施故障吞成「项目不存在」的 404）。
 */
export class AgentRunNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentRunNotFoundError"
  }
}
