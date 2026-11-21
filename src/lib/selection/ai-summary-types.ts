/**
 * 选品 AI 汇总结构（client-safe：schema $type / selection-ai 生成 / 评论洞察
 * 页消费三方共用）。字段全部可缺省——模型输出经 sanitizeSummary 清洗后落库。
 */
export interface SelectionAiSummaryData {
  /** 整体情绪倾向：positive / neutral / negative / mixed */
  sentiment?: string
  /** 0-100 情绪分（越高越正面） */
  sentimentScore?: number
  /** 好评高频卖点（≤5 条） */
  pros?: string[]
  /** 差评/吐槽高频问题（≤5 条） */
  cons?: string[]
  /** 高频关键词（≤8 个） */
  keywords?: string[]
  /** 代表性原文摘录（≤3 条） */
  quotes?: string[]
  /** 给卖家的行动建议 */
  suggestion?: string
  /** 仅 digest：当日热议话题（≤5 条） */
  hotTopics?: string[]
}
