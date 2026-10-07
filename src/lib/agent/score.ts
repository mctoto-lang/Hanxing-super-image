import type { ReviewDimension } from "./graph"

/**
 * 评分可视化纯工具（无 React 依赖，前端/服务端/单测共用）
 *
 * - 三维度 0-100 分 + 及格线 → 档位着色（低分/警告/达标）；
 * - 违规项 key → 中文文案；
 * - 整副卡牌的维度均分与不达标张数统计。
 */

/** 评分档位：low 低分 / warn 60 分以上但未达及格线 / pass 达标 */
export type ScoreTone = "low" | "warn" | "pass"

/** 内容/审美/一致性及格线（缺省值；运行快照中的审核节点配置可覆盖） */
export const DEFAULT_SCORE_THRESHOLDS = {
  content: 60,
  aesthetic: 75,
  consistency: 70,
} as const satisfies Record<ReviewDimension, number>

/** 三维度中文标签 */
export const SCORE_DIMENSION_LABELS = {
  content: "内容分",
  aesthetic: "审美分",
  consistency: "一致性分",
} as const satisfies Record<ReviewDimension, string>

/** 及格线集合（key 与 ReviewDimension 一一对应） */
export type ScoreThresholds = Record<ReviewDimension, number>

/**
 * 常见违规项 key → 中文文案（未收录的 key 由 violationLabel 原样回显）。
 * key 来源：视觉审核模型产出的违规枚举（agent_review.result.violations）。
 */
export const VIOLATION_LABELS = {
  text: "含文字",
  numerals: "含数字",
  number: "含数字",
  border: "含边框",
  incomplete: "画面不完整",
  watermark: "含水印",
} as const

/** 违规项展示文案：已知 key 取中文，未知 key 原样展示（防模型自由发挥丢信息） */
export function violationLabel(key: string): string {
  return VIOLATION_LABELS[key as keyof typeof VIOLATION_LABELS] ?? key
}

/** 把任意分数收敛到 0-100 整数（四舍五入） */
export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

/**
 * 分数 → 档位（着色依据）：
 * - threshold ≤ 60 时不设警告带：≥ threshold 即 pass，否则 low；
 * - threshold > 60 时：< 60 为 low，[60, threshold) 为 warn，≥ threshold 为 pass。
 */
export function scoreTone(score: number, threshold: number): ScoreTone {
  if (threshold <= 60) {
    return score >= threshold ? "pass" : "low"
  }
  if (score < 60) return "low"
  if (score < threshold) return "warn"
  return "pass"
}

/** 单张卡（或候选）三维度得分；null = 该维度未评分 */
export interface DimensionScores {
  content: number | null
  aesthetic: number | null
  consistency: number | null
}
