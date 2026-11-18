/**
 * 运营工作台展示口径常量（核价/调价/广告/备货）
 *
 * 独立模块而非放在 "use server" 的 actions 文件内：server actions 文件
 * 只允许导出 async 函数，常量对象会被 Next.js 构建器拒绝
 * （invalid-use-server-value）。客户端面板与服务端 action 共用此处的
 * 状态/类型文案映射。
 */

/** 核价单状态（bg.price.review.page.query orderStatus） */
export const PRICE_REVIEW_STATUS: Record<number, string> = {
  0: "待核价",
  1: "待供应商确认",
  2: "核价通过",
  3: "核价驳回",
  4: "废弃",
  5: "价格同步中",
}

/** 调价单状态（bg.full.adjust.price.page.query status） */
export const ADJUST_ORDER_STATUS: Record<number, string> = {
  0: "待调价",
  1: "待供应商确认",
  2: "调价成功",
  3: "调价失败",
}

/** 拒绝核价的重新报价原因类型（bg.price.review.reject type） */
export const BARGAIN_REASON_TYPES: Record<number, string> = {
  0: "材质",
  1: "功能",
  2: "其他",
  3: "品类",
  4: "外观",
  5: "版型",
  6: "图案",
  7: "规格尺寸",
  8: "品牌",
}

/** 备货单状态机（purchaseorderv2.get status；temu-go StatusList 注释，官方未公开中文枚举表） */
export const PURCHASE_ORDER_STATUS: Record<number, string> = {
  0: "待接单",
  1: "已接单待发货",
  2: "已送货",
  3: "已收货",
  4: "已拒收",
  5: "已验收全部退回",
  6: "已验收",
  7: "已入库",
  8: "作废",
  9: "已超时",
  10: "已取消",
}

/** 发货单状态机（shiporderv2.get status，官方参数表枚举） */
export const SHIP_ORDER_STATUS: Record<number, string> = {
  0: "待装箱发货",
  1: "待仓库收货",
  2: "已收货",
  3: "已入库",
  4: "已退货",
  5: "已取消",
  6: "部分收货",
}

/** 发货方式（shiporderv2/packing.send deliveryMethod） */
export const SHIP_DELIVERY_METHOD: Record<number, string> = {
  0: "未下单",
  1: "自送",
  2: "平台推荐物流",
  3: "第三方物流",
}

/** 运单计费重量异常状态（shiporderv2 expressWeightFeedbackStatus，官方枚举 0-7） */
export const EXPRESS_WEIGHT_FEEDBACK_STATUS: Record<number, string> = {
  0: "无异常",
  1: "重量异常待确认",
  2: "已提交异常反馈",
  3: "物流商已处理",
  4: "平台介入处理中",
  5: "平台处理完成",
  6: "卖家已确认",
  7: "超期自动确认",
}

/** 物流单拒收状态（shiporderv2 expressRejectStatus，官方枚举） */
export const EXPRESS_REJECT_STATUS: Record<number, string> = {
  0: "无拒收信息",
  1: "存在拒收，待物流商处理",
  2: "存在拒收，物流商已处理",
}

/** 广告展示状态（ad.detail.query adShowStatus，官方 2026-10 参数表 0-15 枚举）；
 *  未命中码值时前端回退展示「状态码 n」。 */
export const TEMU_AD_SHOW_STATUS: Record<number, string> = {
  0: "无余额",
  1: "今日预算为 0",
  2: "商品售罄",
  3: "商品已下架",
  4: "商品审核中",
  5: "审核驳回",
  6: "推广受限",
  7: "已暂停",
  8: "推广中",
  9: "已删除",
  10: "不可创建",
  11: "低流量",
  12: "低流量（soft ROAS）",
  13: "已通过",
  14: "达到月度上限",
  15: "禁止投放",
}

/** 广告阶段（ad.detail.query adPhase：0 一阶段学习期 / 1 二阶段平稳期） */
export const TEMU_AD_PHASE: Record<number, string> = {
  0: "学习期",
  1: "平稳期",
}

/** 广告状态五色语义（与 TEMU_AD_SHOW_STATUS 对齐；未命中码值按 gray 处理）：
 *  green=推广中；gray=已暂停/已删除；blue=审核中/已通过；
 *  amber=低流量/余额预算类/月上限/售罄；red=驳回/受限/下架/不可创建/禁止投放 */
export type TemuAdStatusTone = "green" | "gray" | "blue" | "amber" | "red"
export const TEMU_AD_STATUS_TONE: Record<number, TemuAdStatusTone> = {
  0: "amber",
  1: "amber",
  2: "amber",
  3: "red",
  4: "blue",
  5: "red",
  6: "red",
  7: "gray",
  8: "green",
  9: "gray",
  10: "red",
  11: "amber",
  12: "amber",
  13: "blue",
  14: "amber",
  15: "red",
}

/** 目标 ROAS 归一：官方出参实测两种口径并存（120000=×10000 整数口径 /
 *  14.0 实值口径），>1000 视为万倍口径 ÷10000（与 roas.pred 口径一致，保留两位）。
 *  归一后仍 >1000 视为官方除零哨兵（2026-11-18 实测 summary.roas/netRoas 花费 0
 *  时返回 5e15，真实 ROAS 业务上界远低于 1000）返回 null（页面显示「—」） */
export function normalizeAdRoas(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null
  const n = v > 1000 ? Math.round((v / 10000) * 100) / 100 : v
  return n > 1000 ? null : n
}


/** 站点字典（docs/temu-openapi-guide.md §13.2，2025-09-29 版）：
 *  核价单等接口只返回 siteIds，siteNameList 官方实测不返回——名称由此映射。
 *  文档 172-197 区间只列了 24 个名称（与编号数不一致），按序映射到 172-195，
 *  未覆盖的 id 由 UI 回退显示「站点 <built-in function id>」。 */
export const TEMU_SITES: Record<number, string> = {
  100: "美国站",
  101: "加拿大站",
  102: "英国站",
  103: "澳大利亚站",
  104: "新西兰站",
  105: "德国站",
  106: "法国站",
  107: "意大利站",
  108: "荷兰站",
  109: "西班牙站",
  110: "墨西哥站",
  111: "葡萄牙站",
  112: "波兰站",
  113: "瑞典站",
  114: "瑞士站",
  115: "希腊站",
  116: "爱尔兰站",
  117: "塞浦路斯站",
  118: "日本站",
  119: "韩国站",
  120: "沙特站",
  121: "新加坡站",
  122: "阿联酋站",
  123: "科威特站",
  124: "挪威站",
  125: "智利站",
  126: "马来西亚站",
  127: "菲律宾站",
  128: "中国台湾站",
  129: "泰国站",
  130: "卡塔尔站",
  131: "约旦站",
  132: "巴西站",
  133: "阿曼站",
  134: "巴林站",
  135: "以色列站",
  136: "南非站",
  137: "捷克站",
  138: "匈牙利站",
  139: "丹麦站",
  140: "罗马尼亚站",
  141: "保加利亚站",
  142: "比利时站",
  143: "奥地利站",
  144: "芬兰站",
  145: "斯洛伐克站",
  146: "克罗地亚站",
  147: "斯洛文尼亚站",
  148: "立陶宛站",
  149: "爱沙尼亚站",
  150: "拉脱维亚站",
  151: "马耳他站",
  152: "卢森堡站",
  153: "塞尔维亚站",
  154: "摩尔多瓦站",
  155: "黑山站",
  156: "冰岛站",
  157: "安道尔站",
  158: "波黑站",
  159: "阿尔巴尼亚站",
  160: "哈萨克斯坦站",
  161: "秘鲁站",
  162: "哥伦比亚站",
  163: "格鲁吉亚站",
  164: "亚美尼亚站",
  165: "阿塞拜疆站",
  166: "乌克兰站",
  167: "乌拉圭站",
  168: "科索沃站",
  169: "毛里求斯站",
  170: "摩洛哥站",
  171: "多米尼加站",
  172: "哥斯达黎加站",
  173: "土耳其站",
  174: "阿尔及利亚站",
  175: "巴拿马站",
  176: "肯尼亚站",
  177: "厄瓜多尔站",
  178: "特立尼达和多巴哥站",
  179: "危地马拉站",
  180: "乌兹别克斯坦站",
  181: "洪都拉斯站",
  182: "萨尔瓦多站",
  183: "巴基斯坦站",
  184: "斯里兰卡站",
  185: "蒙古站",
  186: "越南站",
  187: "文莱站",
  188: "阿根廷站",
  189: "尼日利亚站",
  190: "柬埔寨站",
  191: "北马其顿站",
  192: "孟加拉站",
  193: "吉尔吉斯斯坦站",
  194: "马尔代夫站",
  195: "列支敦士登站",
}