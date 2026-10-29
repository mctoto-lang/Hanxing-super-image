import type { ModuleName, TemuTabModule } from "@/db/schema"

/**
 * 模块展示口径（单一来源，客户端可安全引用——仅类型依赖 @/db/schema）
 *
 * 此前模块清单在 4 个弹窗里各自硬编码（modules-dialog /
 * enterprise-create-dialog / group-create / group-edit），新增 key 极易漏改，
 * 收敛到本文件；模块 key 权威来源仍是 db/schema/_shared.ts 的 MODULE_NAMES。
 */

/** 模块中文名（穷举映射，新增 key 不补标签会 TS 编译错） */
export const MODULE_LABELS: Record<ModuleName, string> = {
  create: "创作",
  chat: "AI 对话",
  assets: "资产管理",
  workspace: "批量生图",
  product: "商品图片",
  weartry: "穿戴图片",
  mockup: "样机渲染",
  temu: "TEMU",
  temu_overview: "TEMU-销售概览",
  temu_products: "TEMU-商品信息",
  temu_publish: "TEMU-商品发布",
  temu_ads: "TEMU-广告推广",
  temu_price: "TEMU-核价调价",
  temu_purchase: "TEMU-备货",
  temu_qc: "TEMU-质检",
  temu_ship: "TEMU-发货",
  temu_return: "TEMU-退货",
  settings: "个人设置",
}

export type ModuleOption = { value: ModuleName; label: string }

/** 普通模块勾选项（弹窗基础清单；settings 与 TEMU 区块由各弹窗单独处理） */
export const BASE_MODULE_OPTIONS: ModuleOption[] = [
  { value: "create", label: MODULE_LABELS.create },
  { value: "chat", label: MODULE_LABELS.chat },
  { value: "assets", label: MODULE_LABELS.assets },
  { value: "workspace", label: MODULE_LABELS.workspace },
  { value: "product", label: MODULE_LABELS.product },
  { value: "weartry", label: MODULE_LABELS.weartry },
  { value: "mockup", label: MODULE_LABELS.mockup },
]

/** TEMU tab 子权限项（依赖 temu 总开关：总开关未勾时弹窗内禁用） */
export const TEMU_TAB_OPTIONS: Array<{ value: TemuTabModule; label: string }> = [
  { value: "temu_overview", label: MODULE_LABELS.temu_overview },
  { value: "temu_products", label: MODULE_LABELS.temu_products },
  { value: "temu_publish", label: MODULE_LABELS.temu_publish },
  { value: "temu_ads", label: MODULE_LABELS.temu_ads },
  { value: "temu_price", label: MODULE_LABELS.temu_price },
  { value: "temu_purchase", label: MODULE_LABELS.temu_purchase },
  { value: "temu_ship", label: MODULE_LABELS.temu_ship },
  { value: "temu_qc", label: MODULE_LABELS.temu_qc },
  { value: "temu_return", label: MODULE_LABELS.temu_return },
]
