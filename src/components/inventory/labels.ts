/**
 * 库存域展示口径（枚举文案/徽章色板/状态计算）
 *
 * 徽章为描边（outline）+ 浅底 + 状态圆点口径（InvBadge 渲染），
 * 圆角与 TEMU 页面徽章统一为方角 rounded-[4px]：
 * 库存六态=绿正常/琥珀补货/红缺货/紫滞销/灰停产/橙清仓；
 * 发货状态=蓝自动/粉手动；生产状态=青持续生产/铁灰停止生产。
 * 状态类带彩色圆点（*_DOT 记录），类型类（流水类型）无圆点。
 */

export const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  initial: "期初",
  production_in: "生产入库",
  factory_direct: "工厂直发",
  ship_deduct: "发货扣减",
  manual_in: "手动入库",
  manual_out: "手动出库",
  return_in: "退货入库",
  transfer_out: "调拨出",
  transfer_in: "调拨入",
  stocktake: "盘点",
  reversal: "冲正",
}

export const MOVEMENT_TYPE_BADGE: Record<string, string> = {
  initial: "border-border bg-muted/50 text-muted-foreground",
  production_in: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  factory_direct: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  ship_deduct: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  manual_in: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  manual_out: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  return_in: "border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-400",
  transfer_out: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400",
  transfer_in: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400",
  stocktake: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-400",
  reversal: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400",
}

/** 生产单五态 */
export const PRODUCTION_STATUS_LABELS: Record<string, string> = {
  materials_pending: "待出材料",
  producing: "生产中",
  factory_shipped: "工厂已发",
  received: "已入库",
  finished: "已结束",
}

export const PRODUCTION_STATUS_BADGE: Record<string, string> = {
  materials_pending: "border-border bg-muted/50 text-muted-foreground",
  producing: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  factory_shipped: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  received: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  finished: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-400",
}

/** 生产单状态圆点 */
export const PRODUCTION_STATUS_DOT: Record<string, string> = {
  materials_pending: "bg-muted-foreground/50",
  producing: "bg-sky-500",
  factory_shipped: "bg-amber-500",
  received: "bg-emerald-500",
  finished: "bg-slate-400",
}

/** 库存状态（六态；可售天数=(仓库+TEMU净+在产)÷加权日销，阈值企业级配置） */
export const STOCK_STATUS_LABELS: Record<string, string> = {
  normal: "正常",
  restock: "补货",
  out_of_stock: "缺货",
  stagnant: "滞销",
  discontinued: "停产",
  clearance: "清仓",
}

export const STOCK_STATUS_BADGE: Record<string, string> = {
  normal: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  restock: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  out_of_stock: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  stagnant: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400",
  discontinued: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-400",
  clearance: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400",
}

/** 库存状态圆点 */
export const STOCK_STATUS_DOT: Record<string, string> = {
  normal: "bg-emerald-500",
  restock: "bg-amber-500",
  out_of_stock: "bg-red-500",
  stagnant: "bg-violet-500",
  discontinued: "bg-slate-400",
  clearance: "bg-orange-500",
}

export const PRODUCTION_STATE_LABELS: Record<string, string> = {
  active: "持续生产",
  stopped: "停止生产",
}

export const PRODUCTION_STATE_BADGE: Record<string, string> = {
  active: "border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-400",
  stopped: "border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
}

/** 生产状态（持续/停止）圆点 */
export const PRODUCTION_STATE_DOT: Record<string, string> = {
  active: "bg-teal-500",
  stopped: "bg-zinc-500",
}

/** 发货状态（auto=自动发货/manual=手动发货：均装箱自动扣库存，自动化只跑 auto） */
export const SHIP_STATE_LABELS: Record<string, string> = {
  auto: "自动发货",
  manual: "手动发货",
}

export const SHIP_STATE_BADGE: Record<string, string> = {
  auto: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  manual: "border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-400",
}

/** 发货状态圆点 */
export const SHIP_STATE_DOT: Record<string, string> = {
  auto: "bg-blue-500",
  manual: "bg-pink-500",
}

/** 手动出库类型（manual_out 的 reason 前缀规范，弹窗下拉选项） */
export const MANUAL_OUT_KINDS = [
  "Amazon出库",
  "TEMU出库",
  "样品领用",
  "库存调度",
  "其他",
] as const

/** 手动入库类型（「退货入库」走 return_in 流水类型，其余 manual_in + 前缀） */
export const MANUAL_IN_KINDS = ["退货入库", "盘点入库", "其他入库"] as const

/** 档案字段中文名（变更日志 field 列存 key，展示层映射） */
export const PRODUCT_FIELD_LABELS: Record<string, string> = {
  name: "款名",
  imageUrl: "图片",
  cartonQty: "装箱数",
  leadTimeDays: "生产周期",
  stockUpper: "库存上限",
  moq: "最小生产量",
  barcodePrePasted: "条码",
  productionState: "生产状态",
  shipState: "发货状态",
  note: "备注",
}
