/**
 * 奖励礼物通知共享类型（client-safe，纯类型与常量）
 *
 * 事件由 service 层在套餐/积分发放成功后写入 reward_notice；
 * 客户端 RewardPopup 轮询 /api/reward-notices 拿 DTO 弹「滑动开礼物」卡片。
 */

/** 事件类型（与 reward_notice.type 一一对应） */
export const REWARD_NOTICE_TYPES = [
  "plan_assigned", // 超管给企业开通（重分配）套餐
  "plan_renewed", // 超管给企业续约套餐
  "plan_grant", // 套餐周期自动发放（worker 巡检）
  "recharge", // 超管给企业池充值积分
  "member_allocation", // 企业管理员向成员分配积分（定向）
] as const

export type RewardNoticeType = (typeof REWARD_NOTICE_TYPES)[number]

/** payload：展示就绪字段（写入时填充，弹卡端直接渲染） */
export interface RewardPayload {
  /** 套餐名（套餐类事件） */
  planName?: string
  /** 套餐勋章图标 key（src/lib/plans/badge.ts 白名单） */
  planIconKey?: string
  /** 套餐勋章颜色（#RRGGBB） */
  planColor?: string
  /** 套餐本期实发积分（套餐类事件） */
  credits?: number
  /** 充值/分配积分数额（积分类事件） */
  amount?: number
  /** 套餐（新）到期时间 ISO（套餐类事件） */
  expiresAt?: string
  /** 本期周期结束 ISO（plan_grant） */
  periodEnd?: string
  /** 续约是否断档重开（plan_renewed） */
  restarted?: boolean
  /** 操作人显示名（写入时解析，昵称缺省回退用户名） */
  operatorName?: string
  /** 备注（充值/分配可带） */
  remark?: string
}

/** 轮询接口返回的待弹事件 DTO */
export interface RewardNoticeDto {
  /** 通知 id（收下/关闭时 POST 回传，服务端据此推进已读游标） */
  id: string
  type: RewardNoticeType
  payload: RewardPayload
  /** 服务端 created_at ISO */
  createdAt: string
}
