import { pgEnum } from "drizzle-orm/pg-core"

/**
 * 共享枚举定义（手册 §4）
 *
 * 多租户、角色、状态、积分流水等枚举集中定义，供各域 schema 复用。
 */

/** 业务模块名（手册 D22：企业级模块开关） */
export const MODULE_NAMES = [
  "create", // 统一创作页
  "chat", // AI 对话
  "assets", // 资产管理
  "workspace", // 批量生图工作台
  "product", // 商品主图
  "weartry", // 穿戴图片（服装组图/模特穿戴/AI万戴/AI换色）
  "mockup", // 样机渲染
  "settings", // 用户个人设置（默认开通）
] as const
export type ModuleName = (typeof MODULE_NAMES)[number]

/** 企业状态 */
export const enterpriseStatusEnum = pgEnum("enterprise_status", [
  "active", // 正常
  "suspended", // 停用（成员可登录但操作全部 403，§R9）
])

/** 企业内角色（手册 D19：owner/admin/member） */
export const enterpriseRoleEnum = pgEnum("enterprise_role", [
  "owner", // 企业管理员（企业最高管理员，创建企业时自动赋予首位）
  "admin", // 企业管理员（管本企业成员、权限组、模型）
  "member", // 企业成员（使用积分生图，只看自己任务）
])
export type EnterpriseRole = (typeof enterpriseRoleEnum.enumValues)[number]

/** 用户状态 */
export const userStatusEnum = pgEnum("user_status", ["active", "disabled"])

/** 积分流水类型 */
export const creditTxTypeEnum = pgEnum("credit_tx_type", [
  "recharge", // 充值（正，超管充值企业池）
  "consumption", // 消费（负，企业池直接扣减，保留兼容）
  "refund", // 退款（正，任务失败退还企业池）
  "adjustment", // 人工调整（可正可负）
  "allocation", // 分配（负，企业管理员从企业池下发到成员个人配额）
  "allocation_deduct", // 个人配额消费（负，成员生图扣个人配额）
  "allocation_refund", // 个人配额退还（正，任务失败退还到成员个人配额）
])
export type CreditTxType = (typeof creditTxTypeEnum.enumValues)[number]

/** AI 模型 API 格式（openai = OpenAI 标准生图，jimeng = 即梦） */
export const apiFormatEnum = pgEnum("api_format", ["openai", "jimeng"])

/** 任务状态 */
export const taskStatusEnum = pgEnum("task_status", [
  "queued", // 排队中
  "processing", // 处理中
  "completed", // 完成
  "failed", // 失败
])

/** 任务类型（统一来源，手册 D13） */
export const taskTypeEnum = pgEnum("task_type", [
  "normal", // 普通创作
  "workspace_single", // 工作台单图
  "workspace_batch", // 工作台批量
  "product", // 商品主图
  "weartry", // 穿戴图片（服装组图/模特穿戴/AI万戴/AI换色）
  "mockup", // 样机渲染（外部 psd-render-api，无 AI 模型）
])

/** 任务来源（合并 creative/project → create，手册 D13） */
export const taskSourceEnum = pgEnum("task_source", [
  "create",
  "workspace",
  "product",
  "weartry",
  "mockup",
])
