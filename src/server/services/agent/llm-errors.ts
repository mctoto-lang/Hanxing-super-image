/**
 * Agent LLM 输出校验错误类型（零依赖小模块）。
 * 独立成模块是为了让纯函数解析器（template-parse）与对应单测
 * 不再经 llm.ts → task-queue → redis 的 import 链连上真实 Redis。
 */

/** 字段校验失败（可触发一次纠错重试） */
export class LlmValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LlmValidationError"
  }
}
