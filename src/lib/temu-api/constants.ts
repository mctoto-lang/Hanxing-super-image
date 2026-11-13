/**
 * TEMU 域 client-safe 常量（无 server-only 依赖：客户端组件
 * store-manager 与 server 侧 actions 共用同一上限口径）。
 */

/** 单应用（主体）下店铺数上限（创建店铺时校验；店铺管理页展示 n/20） */
export const MAX_STORES_PER_APP = 20
